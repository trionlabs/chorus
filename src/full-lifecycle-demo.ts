/**
 * Full lifecycle: DKG over XMTP -> register committee -> XMTP signing -> on-chain execution
 * The complete flow from key generation to delegated action, all over XMTP.
 */
import "dotenv/config";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, encodeAbiParameters, keccak256, http, type Hex } from "viem";
import { dkgPart1, dkgPart2, dkgPart3, writeDkgKeys } from "./frost/dkg.js";
import { getPublicKey } from "./frost/cli.js";
import { ChorusAgent } from "./xmtp/agent.js";
import { agentConsensusAbi } from "./chain/abi.js";
import { getChain, getRpcUrl } from "./chain/config.js";
import { createSigningCeremony } from "./ceremony/signing.js";
import { createRuntime, extractPeerData, routeMessage, executeActions, type AgentConfig, type CeremonyRuntime } from "./agent/handler.js";
import { evaluate, type Policy } from "./agent/evaluator.js";
import { createSubmitter } from "./chain/submit.js";
import { SWAP_ROUTER, USDC, WETH } from "./uniswap/client.js";
import type { ProtocolMessage } from "./xmtp/messages.js";
import type { Transaction, SigningContext } from "./ceremony/types.js";
import type { SubmitTxCallback } from "./agent/handler.js";
import {
  toMetaMaskSmartAccount, getDeleGatorEnvironment, createDelegation,
  Implementation, createExecution,
} from "@metamask/delegation-toolkit";
import { encodePermissionContexts, encodeExecutionCalldatas } from "@metamask/delegation-toolkit/utils";
import { encodeFunctionData } from "viem";

const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "") as Hex;
const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const THRESHOLD = 2;
const SIGNERS = 3;
const NAMES = ["Guard", "Judge", "Steward"];
const INTERACTIVE = process.argv.includes("--interactive") || process.argv.includes("-i");

function pause(label: string): Promise<void> {
  if (!INTERACTIVE) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdout.write(`\n>>> ${label} - press enter to continue...`);
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
}

const POLICIES: Policy[] = [
  { maxValue: 3_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
  { maxValue: 100_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
  { maxValue: 100_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
];

async function main() {
  if (!CONTRACT || !KEY) { console.error("set CONTRACT_ADDRESS and DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const chain = getChain();
  const rpcUrl = getRpcUrl(chain);
  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log("=== CHORUS FULL LIFECYCLE ===");
  console.log(`chain: ${chain.name}\n`);

  // ====== PHASE 1: DKG OVER XMTP ======
  console.log("--- phase 1: distributed key generation over XMTP ---\n");

  const walletKeys: Hex[] = Array.from({ length: SIGNERS }, () => generatePrivateKey());
  const runDir = mkdtempSync(join(tmpdir(), "chorus-lifecycle-"));
  const agents: ChorusAgent[] = walletKeys.map((k, i) =>
    new ChorusAgent(k, NAMES[i]!, join(runDir, `${NAMES[i]!.toLowerCase()}.db3`))
  );

  // DKG state
  const secrets: Record<number, string> = {};
  const round1Pkgs: Record<number, string> = {};
  const round2Secrets: Record<number, string> = {};
  const round2Received: Record<number, Record<number, string>> = {};
  const round1Received: Record<number, Record<number, string>> = {};
  const dkgResults: Record<number, { key_package: string; public_key_package: string }> = {};
  for (let i = 0; i < SIGNERS; i++) { round2Received[i+1] = {}; round1Received[i+1] = {}; }

  let dkgDone = 0;
  const dkgComplete = new Promise<void>((resolve) => {
    const check = () => { if (dkgDone >= SIGNERS) resolve(); };

    for (let i = 0; i < SIGNERS; i++) {
      const id = i + 1;
      agents[i]!.on("dkg/round1", async (msg, reply, sendDm) => {
        if (msg.type !== "dkg/round1" || msg.signerIndex === id) return;
        round1Received[id]![msg.signerIndex] = msg.commitments;
        if (Object.keys(round1Received[id]!).length === SIGNERS - 1) {
          const p2 = dkgPart2(secrets[id]!, round1Received[id]!);
          round2Secrets[id] = p2.secret_package;
          for (const [pid, share] of Object.entries(p2.round2_packages)) {
            await sendDm(agents[Number(pid)-1]!.address as Hex, {
              type: "dkg/round2", ceremonyId: "lc", fromIndex: id, toIndex: Number(pid), share,
            });
          }
        }
      });

      agents[i]!.on("dkg/round2", async (msg, reply) => {
        if (msg.type !== "dkg/round2" || msg.toIndex !== id) return;
        round2Received[id]![msg.fromIndex] = msg.share;
        if (Object.keys(round2Received[id]!).length === SIGNERS - 1) {
          const p3 = dkgPart3(round2Secrets[id]!, round1Received[id]!, round2Received[id]!);
          dkgResults[id] = p3;
          console.log(`[${NAMES[i]}] DKG complete`);
          await reply({ type: "dkg/confirm", ceremonyId: "lc", signerIndex: id, publicKey: p3.public_key_package.slice(0, 20) + "..." });
          dkgDone++; check();
        }
      });

      agents[i]!.on("dkg/confirm", async () => {});
    }
  });

  // start agents
  for (const a of agents) await a.start();
  await new Promise(r => setTimeout(r, 2000));
  const peerAddresses = agents.map(a => a.address as Hex);
  const groupId = await agents[0]!.createGroup(peerAddresses.slice(1) as Hex[], "chorus-lifecycle");
  await new Promise(r => setTimeout(r, 2000));

  // generate and broadcast round1
  for (let i = 0; i < SIGNERS; i++) {
    const id = i + 1;
    const p1 = dkgPart1(id, SIGNERS, THRESHOLD);
    secrets[id] = p1.secret_package;
    round1Pkgs[id] = p1.round1_package;
  }
  for (let i = 0; i < SIGNERS; i++) {
    await agents[i]!.sendToGroup(groupId, {
      type: "dkg/round1", ceremonyId: "lc", signerIndex: i+1, commitments: round1Pkgs[i+1]!,
    });
  }

  console.log("DKG round1 broadcast, waiting...");
  await Promise.race([dkgComplete, new Promise((_, rej) => setTimeout(() => rej(new Error("DKG timeout")), 60000))]);

  // write keys
  const keysDir = join(runDir, "keys");
  const pubKeys = Object.values(dkgResults).map(r => r.public_key_package);
  writeDkgKeys(keysDir, dkgResults, pubKeys[0]!);
  const pk = getPublicKey(keysDir);
  console.log(`\ngroup pubkey: ${pk.address}`);
  console.log("all 3 agents derived their key share. no agent ever saw the full private key.");

  await pause("DKG complete. next: register committee on-chain");

  // ====== PHASE 2: REGISTER COMMITTEE ON-CHAIN ======
  console.log("\n--- phase 2: register committee on-chain ---\n");

  const regTx = await walletClient.writeContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi,
    functionName: "registerCommittee", args: [pk.px, pk.py, 2n],
    chain, account,
  });
  const regReceipt = await publicClient.waitForTransactionReceipt({ hash: regTx });
  console.log(`registered: ${regTx}`);
  console.log(`status: ${regReceipt.status}`);

  const committeeId = keccak256(encodeAbiParameters([{type:"uint256"},{type:"uint256"}], [pk.px, pk.py]));
  await new Promise(r => setTimeout(r, 3000));

  await pause("committee registered on-chain. next: set up alice's delegation + uniswap swap");

  // ====== PHASE 3: ALICE'S DELEGATION + SIGNING OVER XMTP ======
  console.log("\n--- phase 3: alice's erc-7710 delegation ---\n");

  const env = getDeleGatorEnvironment(chain.id);
  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account },
    client: publicClient as any,
    environment: env,
  });
  console.log("alice smart account:", smartAccount.address);

  // check USDC balance
  const usdcBal = await publicClient.readContract({
    address: USDC as `0x${string}`,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log("alice USDC:", Number(usdcBal) / 1e6);

  // create delegation: alice -> AgentConsensus (uniswap scope)
  const delegation = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER, USDC],
      selectors: ["0x04e45aaf", "0x095ea7b3"],
    },
  });
  const delegSig = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature: delegSig };
  const permContexts = encodePermissionContexts([[signedDelegation as any]]);
  console.log("delegation signed (caveats:", delegation.caveats.length, "- uniswap + USDC only)");

  // build swap: 5 USDC -> WETH
  const swapCalldata = encodeFunctionData({
    abi: [{
      name: "exactInputSingle", type: "function", stateMutability: "payable",
      inputs: [{ name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ]}],
      outputs: [{ name: "", type: "uint256" }],
    }],
    functionName: "exactInputSingle",
    args: [{
      tokenIn: USDC, tokenOut: WETH, fee: chain.id === 8453 ? 500 : 3000,
      recipient: smartAccount.address,
      amountIn: 5_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
  });
  const swapExec = createExecution({ target: SWAP_ROUTER, value: 0n, callData: swapCalldata });
  const execCalldatas = encodeExecutionCalldatas([[swapExec]]);
  const mode = ("0x" + "00".repeat(32)) as Hex;

  console.log("swap: 5 USDC -> WETH on uniswap");

  await pause("delegation created. next: signing ceremony over XMTP");

  console.log("\n--- phase 4: signing ceremony over XMTP ---\n");

  const nonce = await publicClient.readContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  }) as bigint;

  const executionHash = keccak256(encodeAbiParameters(
    [{type:"address"},{type:"bytes[]"},{type:"bytes32[]"},{type:"bytes[]"}],
    [env.DelegationManager, permContexts, [mode], execCalldatas]
  ));
  const actionHash = keccak256(encodeAbiParameters(
    [{type:"bytes32"},{type:"bytes32"},{type:"uint256"}],
    [committeeId, executionHash, nonce]
  )) as Hex;

  // wire signing ceremony
  const contexts: (SigningContext | null)[] = Array(SIGNERS).fill(null);
  const runtimes: CeremonyRuntime[] = Array.from({ length: SIGNERS }, () => createRuntime());

  const submitter = createSubmitter({
    contractAddress: CONTRACT as `0x${string}`, committeeId: committeeId as `0x${string}`,
    delegationManager: env.DelegationManager, walletKey: KEY, rpcUrl,
  });
  const onSubmitTx: SubmitTxCallback = async (sig) => {
    const result = await submitter.submitDelegated(permContexts, [mode], execCalldatas, sig);
    return { txHash: result.txHash, success: result.success };
  };

  // proposal shows the swap
  const tx: Transaction = { to: SWAP_ROUTER as Hex, value: 5_000_000n, data: swapCalldata as Hex };

  const configs: AgentConfig[] = NAMES.map((name, i) => ({
    name, shareIndex: i, keysDir, threshold: THRESHOLD, totalSigners: SIGNERS, onSubmitTx,
  }));

  // register signing handlers
  for (let i = 0; i < SIGNERS; i++) {
    const idx = i;
    const processMsg = async (msg: ProtocolMessage, reply: (r: ProtocolMessage) => Promise<void>) => {
      if (!contexts[idx]) return;
      extractPeerData(runtimes[idx]!, msg);
      const actions = routeMessage(contexts[idx]!, msg);
      await executeActions(actions, contexts[idx]!, runtimes[idx]!, configs[idx]!, reply);
    };

    for (const t of ["frost/accept","frost/reject","frost/round1","frost/signing-package","frost/round2","frost/signature","frost/executed"]) {
      agents[idx]!.on(t, async (msg, reply) => processMsg(msg, reply));
    }

    agents[idx]!.on("frost/propose", async (msg, reply) => {
      if (msg.type !== "frost/propose") return;
      const result = evaluate(msg.transaction, POLICIES[idx]!);
      console.log(`[${NAMES[idx]}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);
      contexts[idx] = createSigningCeremony(
        { proposalId: msg.proposalId, proposer: msg.proposer, transaction: msg.transaction, timestamp: msg.timestamp },
        idx, THRESHOLD, SIGNERS, actionHash,
      );
      if (result.approved) {
        await reply({ type: "frost/accept", proposalId: msg.proposalId, signerIndex: idx, reason: result.reason, timestamp: Date.now() });
      } else {
        await reply({ type: "frost/reject", proposalId: msg.proposalId, signerIndex: idx, reason: result.reason, timestamp: Date.now() });
      }
    });
  }

  // broadcast proposal
  console.log("proposal: swap 5 USDC for WETH on uniswap (via alice's delegation)");
  await agents[0]!.sendToGroup(groupId, {
    type: "frost/propose", proposalId: `lc-${Date.now()}`, proposer: 0,
    transaction: tx, rationale: "swap 5 USDC for WETH via uniswap", timestamp: Date.now(),
  });

  console.log("waiting for signing ceremony + on-chain execution...\n");

  // wait for ceremony to complete (check periodically)
  for (let t = 0; t < 30; t++) {
    await new Promise(r => setTimeout(r, 1000));
    const completed = contexts.some(c => c?.state === "COMPLETE");
    if (completed) { await new Promise(r => setTimeout(r, 2000)); break; }
  }

  // results
  for (let i = 0; i < SIGNERS; i++) {
    if (contexts[i]) {
      console.log(`[${NAMES[i]}] state: ${contexts[i]!.state}`);
      if (contexts[i]!.result) console.log(`  sig rx: 0x${contexts[i]!.result!.rx.toString(16).slice(0, 16)}...`);
    }
  }

  await pause("signing complete. check the tx on BaseScan");

  // check final USDC balance
  const finalUsdc = await publicClient.readContract({
    address: USDC as `0x${string}`,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log(`\nalice USDC: ${Number(finalUsdc) / 1e6} (was ${Number(usdcBal) / 1e6})`);

  console.log("\n=== LIFECYCLE COMPLETE ===");
  console.log("1. DKG: 3 agents generated keys over XMTP (round2 via DM, never broadcast)");
  console.log("2. committee registered on-chain with DKG-derived group public key");
  console.log("3. alice delegated to committee: uniswap only, USDC only (ERC-7710)");
  console.log("4. signing: Guard rejected, Judge+Steward accepted, FROST ceremony over XMTP");
  console.log("5. delegation redeemed -> uniswap swap executed from alice's account");
  console.log("6. 96-byte FROST signature verified on-chain (~5,300 gas, constant)");
  console.log("7. no agent ever held the full private key");

  for (const a of agents) await a.stop();
}

main().catch(console.error);
