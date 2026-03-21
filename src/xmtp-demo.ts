import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
} from "viem";
import { getPublicKey } from "./frost/cli.js";
import { createSubmitter } from "./chain/submit.js";
import { getChain, getRpcUrl } from "./chain/config.js";
import { createSigningCeremony } from "./ceremony/signing.js";
import {
  createRuntime,
  extractPeerData,
  routeMessage,
  executeActions,
  type AgentConfig,
  type CeremonyRuntime,
} from "./agent/handler.js";
import { evaluate, type Policy } from "./agent/evaluator.js";
import { ChorusAgent } from "./xmtp/agent.js";
import type { ProtocolMessage } from "./xmtp/messages.js";
import type { Hex, Transaction, SigningContext } from "./ceremony/types.js";
import type { SubmitTxCallback } from "./agent/handler.js";
import { SWAP_ROUTER, USDC, WETH } from "./uniswap/client.js";
import { agentConsensusAbi } from "./chain/abi.js";
import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  createDelegation,
  Implementation,
  createExecution,
} from "@metamask/delegation-toolkit";
import {
  encodePermissionContexts,
  encodeExecutionCalldatas,
} from "@metamask/delegation-toolkit/utils";

const THRESHOLD = 2;
const SIGNERS = 3;

const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Hex;
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;

const AGENT_NAMES = ["Guard", "Judge", "Steward"];

// guard is conservative on amounts, judge and steward accept within bounds
const POLICIES: Policy[] = [
  { maxValue: 3_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
  { maxValue: 100_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
  { maxValue: 100_000_000n, allowedTargets: [SWAP_ROUTER.toLowerCase(), USDC.toLowerCase()] },
];

async function main() {
  console.log("--- chorus xmtp demo ---\n");

  if (!CONTRACT_ADDRESS || !DEPLOYER_KEY) {
    console.error("set CONTRACT_ADDRESS and DEPLOYER_PRIVATE_KEY");
    process.exit(1);
  }

  const chain = getChain();
  const rpcUrl = getRpcUrl(chain);
  console.log(`chain: ${chain.name}`);

  // frost keys
  const keysDir = process.env.FROST_KEYS_DIR ?? ".frost";
  const pk = getPublicKey(keysDir);
  console.log(`frost group pubkey: ${pk.address}`);

  const committeeId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [pk.px, pk.py]
    )
  );

  // --- set up real delegation ---
  const aliceAccount = privateKeyToAccount(DEPLOYER_KEY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const env = getDeleGatorEnvironment(chain.id);

  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [aliceAccount.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account: aliceAccount },
    client: publicClient as any,
    environment: env,
  });
  console.log(`alice smart account: ${smartAccount.address}`);

  // create delegation: alice -> AgentConsensus (uniswap + usdc scope)
  const delegation = createDelegation({
    environment: env,
    to: CONTRACT_ADDRESS as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER, USDC],
      selectors: ["0x04e45aaf", "0x095ea7b3"], // exactInputSingle, approve
    },
  });
  const delegationSig = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature: delegationSig };
  const permContexts = encodePermissionContexts([[signedDelegation as any]]);
  console.log("delegation signed with caveats:", delegation.caveats.length);

  // build the swap execution: 5 USDC -> WETH
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
      amountIn: 5_000_000n, // 5 USDC
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
  });

  const swapExec = createExecution({ target: SWAP_ROUTER, value: 0n, callData: swapCalldata });
  const execCalldatas = encodeExecutionCalldatas([[swapExec]]);
  const mode = ("0x" + "00".repeat(32)) as Hex;

  // read nonce and compute action hash with REAL delegation data
  const nonce = await publicClient.readContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "getNonce",
    args: [committeeId],
  }) as bigint;
  console.log(`on-chain nonce: ${nonce}`);

  const executionHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [env.DelegationManager, permContexts, [mode], execCalldatas]
    )
  );
  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, executionHash, nonce]
    )
  ) as Hex;
  console.log(`action hash: ${actionHash.slice(0, 18)}...`);

  // wire on-chain submission with REAL delegation data
  let onSubmitTx: SubmitTxCallback | undefined;
  const submitter = createSubmitter({
    contractAddress: CONTRACT_ADDRESS as `0x${string}`,
    committeeId: committeeId as `0x${string}`,
    delegationManager: env.DelegationManager,
    walletKey: DEPLOYER_KEY,
    rpcUrl: rpcUrl,
  });
  onSubmitTx = async (sig) => {
    const result = await submitter.submitDelegated(
      permContexts,
      [mode],
      execCalldatas,
      sig,
    );
    return { txHash: result.txHash, success: result.success };
  };

  // load persistent XMTP keys if available, otherwise generate fresh
  let walletKeys: Hex[];
  const keysFile = join(keysDir, "agents", "xmtp-keys.json");
  try {
    const { readFileSync } = await import("fs");
    const saved = JSON.parse(readFileSync(keysFile, "utf-8"));
    walletKeys = [saved.guard.key, saved.judge.key, saved.steward.key] as Hex[];
    console.log("loaded persistent XMTP keys");
  } catch {
    walletKeys = Array.from({ length: SIGNERS }, () => generatePrivateKey());
    console.log("using fresh XMTP keys (no persistent keys found)");
  }

  // create agents with fresh db paths
  const runDir = mkdtempSync(join(tmpdir(), "chorus-run-"));
  const agents: ChorusAgent[] = walletKeys.map((key, i) => {
    const dbPath = join(runDir, `${AGENT_NAMES[i]!.toLowerCase()}.db3`);
    return new ChorusAgent(key, AGENT_NAMES[i]!, dbPath);
  });

  // ceremony state per agent
  const contexts: (SigningContext | null)[] = Array(SIGNERS).fill(null);
  const runtimes: CeremonyRuntime[] = Array.from({ length: SIGNERS }, () => createRuntime());
  const configs: AgentConfig[] = AGENT_NAMES.map((name, i) => ({
    name,
    shareIndex: i,
    keysDir,
    threshold: THRESHOLD,
    totalSigners: SIGNERS,
    onSubmitTx,
  }));

  // the proposal transaction (what agents evaluate)
  const target = SWAP_ROUTER;
  const tx: Transaction = {
    to: target as Hex,
    value: 5_000_000n, // agents evaluate the USDC amount (5 USDC)
    data: swapCalldata as Hex,
  };

  const proposalId = `proposal-${Date.now()}`;

  // register handlers
  for (let i = 0; i < SIGNERS; i++) {
    const idx = i;
    const agent = agents[idx]!;

    const processMessage = async (
      msg: ProtocolMessage,
      reply: (r: ProtocolMessage) => Promise<void>,
    ) => {
      if (!contexts[idx]) return;
      extractPeerData(runtimes[idx]!, msg);
      const actions = routeMessage(contexts[idx]!, msg);
      await executeActions(actions, contexts[idx]!, runtimes[idx]!, configs[idx]!, reply);
    };

    for (const type of [
      "frost/accept", "frost/reject", "frost/round1",
      "frost/signing-package", "frost/round2",
      "frost/signature", "frost/executed",
    ]) {
      agent.on(type, async (msg, reply) => {
        await processMessage(msg, reply);
      });
    }

    agent.on("frost/propose", async (msg, reply) => {
      if (msg.type !== "frost/propose") return;

      const useAi = process.env.USE_AI === "true" || process.argv.includes("--ai");
      let result;
      if (useAi) {
        const { aiEvaluate } = await import("./agent/ai-evaluator.js");
        const { AGENT_ROLES } = await import("./agent/config.js");
        result = await aiEvaluate(msg.transaction, AGENT_ROLES[idx]!);
      } else {
        result = evaluate(msg.transaction, POLICIES[idx]!);
      }
      console.log(`[${AGENT_NAMES[idx]}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);

      contexts[idx] = createSigningCeremony(
        {
          proposalId: msg.proposalId,
          proposer: msg.proposer,
          transaction: msg.transaction,
          timestamp: msg.timestamp,
        },
        idx,
        THRESHOLD,
        SIGNERS,
        actionHash,
      );

      if (result.approved) {
        await reply({
          type: "frost/accept",
          proposalId: msg.proposalId,
          signerIndex: idx,
          reason: result.reason,
          timestamp: Date.now(),
        });
      } else {
        await reply({
          type: "frost/reject",
          proposalId: msg.proposalId,
          signerIndex: idx,
          reason: result.reason,
          timestamp: Date.now(),
        });
      }
    });
  }

  // start agents
  console.log("\nstarting agents...");
  for (const agent of agents) {
    await agent.start();
  }
  await new Promise((r) => setTimeout(r, 2000));

  const peerAddresses = agents.map((a) => a.address as Hex);
  console.log(`\nagent addresses:`);
  peerAddresses.forEach((addr, i) => console.log(`  ${AGENT_NAMES[i]}: ${addr}`));

  const groupId = await agents[0]!.createGroup(
    peerAddresses.slice(1) as Hex[],
    "chorus-committee"
  );
  console.log(`group created: ${groupId.slice(0, 16)}...`);
  await new Promise((r) => setTimeout(r, 2000));

  // broadcast proposal
  console.log(`\nproposal: swap 5 USDC for WETH on Uniswap`);
  await agents[0]!.sendToGroup(groupId, {
    type: "frost/propose",
    proposalId,
    proposer: 0,
    transaction: tx,
    rationale: "swap 5 USDC for WETH via Uniswap",
    timestamp: Date.now(),
  });

  // wait for ceremony + on-chain execution
  console.log("\nwaiting for ceremony + on-chain execution...");
  await new Promise((r) => setTimeout(r, 45000));

  // results
  for (let i = 0; i < SIGNERS; i++) {
    const ctx = contexts[i];
    if (ctx) {
      console.log(`[${AGENT_NAMES[i]}] state: ${ctx.state}`);
      if (ctx.result) {
        console.log(`  signature rx: 0x${ctx.result.rx.toString(16).slice(0, 16)}...`);
      }
    }
  }

  // check USDC balance
  const finalUsdc = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log(`\nalice USDC balance: ${Number(finalUsdc) / 1e6} USDC`);

  for (const agent of agents) {
    await agent.stop();
  }
  console.log("done.");
}

main().catch(console.error);
