import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, keccak256 } from "viem";
import { generateKeys, getPublicKey } from "./frost/cli.js";
import { createSubmitter } from "./chain/submit.js";
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
import type {
  Hex,
  Transaction,
  SigningContext,
} from "./ceremony/types.js";
import type { SubmitTxCallback } from "./agent/handler.js";

const THRESHOLD = 2;
const SIGNERS = 3;

const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Hex;
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;

const AGENT_NAMES = ["Guard", "Judge", "Steward"];

const POLICIES: Policy[] = [
  // guard: conservative, max 0.0005 ETH
  { maxValue: 500000000000000n, allowedTargets: ["0x000000000000000000000000000000000000dead"] },
  // judge: strict but reasonable, max 0.01 ETH
  { maxValue: 10000000000000000n, allowedTargets: ["0x000000000000000000000000000000000000dead"] },
  // steward: pragmatic, max 0.01 ETH
  { maxValue: 10000000000000000n, allowedTargets: ["0x000000000000000000000000000000000000dead"] },
];

async function main() {
  console.log("--- chorus xmtp demo ---\n");

  // use existing frost keys (must be pre-generated and registered on-chain)
  const keysDir = process.env.FROST_KEYS_DIR ?? ".frost";
  const pk = getPublicKey(keysDir);
  console.log(`frost group pubkey: ${pk.address}`);

  const committeeId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [pk.px, pk.py]
    )
  );

  // generate xmtp wallet keys
  const walletKeys: Hex[] = Array.from({ length: SIGNERS }, () => generatePrivateKey());

  // create agents with fresh db paths each run
  const runDir = mkdtempSync(join(tmpdir(), "chorus-run-"));
  const agents: ChorusAgent[] = walletKeys.map((key, i) => {
    const dbPath = join(runDir, `${AGENT_NAMES[i]!.toLowerCase()}.db3`);
    return new ChorusAgent(key, AGENT_NAMES[i]!, dbPath);
  });

  // per-agent ceremony state
  const contexts: (SigningContext | null)[] = Array(SIGNERS).fill(null);
  const runtimes: CeremonyRuntime[] = Array.from({ length: SIGNERS }, () => createRuntime());
  // wire on-chain submission if contract is configured
  let onSubmitTx: SubmitTxCallback | undefined;
  if (CONTRACT_ADDRESS && DEPLOYER_KEY) {
    const submitter = createSubmitter({
      contractAddress: CONTRACT_ADDRESS as `0x${string}`,
      committeeId: committeeId as `0x${string}`,
      delegationManager: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      walletKey: DEPLOYER_KEY,
      rpcUrl: process.env.BASE_SEPOLIA_RPC,
    });
    onSubmitTx = async (sig) => {
      const result = await submitter.submitDelegated(
        ["0xdead"] as `0x${string}`[],
        [("0x" + "00".repeat(32)) as `0x${string}`],
        ["0xcafe"] as `0x${string}`[],
        sig,
      );
      return { txHash: result.txHash, success: result.success };
    };
    console.log("on-chain submission enabled");
  }

  const configs: AgentConfig[] = AGENT_NAMES.map((name, i) => ({
    name,
    shareIndex: i,
    keysDir,
    threshold: THRESHOLD,
    totalSigners: SIGNERS,
    onSubmitTx, // coordinator (lowest accepted index) will submit
  }));

  // proposal
  const target = "0x000000000000000000000000000000000000dEaD" as Hex;
  const tx: Transaction = {
    to: target,
    value: 1000000000000000n, // 0.001 ETH
    data: "0x" as Hex,
  };

  // the delegation call data that will be submitted on-chain
  // (must match what onSubmitTx sends)
  const mockDM = "0x0000000000000000000000000000000000000000" as Hex;
  const permContexts = ["0xdead"] as Hex[];
  const modes = [("0x" + "00".repeat(32)) as Hex];
  const execDatas = ["0xcafe"] as Hex[];

  // compute execution hash matching what the contract will compute
  const executionHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [mockDM, permContexts, modes, execDatas]
    )
  );

  // read current nonce from contract (or use 0 if no contract)
  let nonce = 0n;
  if (CONTRACT_ADDRESS) {
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const { agentConsensusAbi } = await import("./chain/abi.js");
    const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC) });
    nonce = await pub.readContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      abi: agentConsensusAbi,
      functionName: "getNonce",
      args: [committeeId as `0x${string}`],
    }) as bigint;
    console.log(`on-chain nonce: ${nonce}`);
  }

  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, executionHash, nonce]
    )
  ) as Hex;

  const proposalId = `proposal-${Date.now()}`;

  // register message handlers for each agent
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

    // register handlers for all signing ceremony message types
    for (const type of [
      "frost/accept",
      "frost/reject",
      "frost/round1",
      "frost/signing-package",
      "frost/round2",
      "frost/signature",
      "frost/executed",
    ]) {
      agent.on(type, async (msg, reply) => {
        await processMessage(msg, reply);
      });
    }

    // handle proposals: evaluate and respond
    agent.on("frost/propose", async (msg, reply) => {
      if (msg.type !== "frost/propose") return;

      const result = evaluate(msg.transaction, POLICIES[idx]!);
      console.log(`[${AGENT_NAMES[idx]}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);

      // create ceremony context
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

  // start all agents
  console.log("\nstarting agents...");
  for (const agent of agents) {
    await agent.start();
  }

  // wait for all agents to be ready
  await new Promise((r) => setTimeout(r, 2000));

  // create group
  const peerAddresses = agents.map((a) => a.address as Hex);
  console.log(`\nagent addresses:`);
  peerAddresses.forEach((addr, i) => console.log(`  ${AGENT_NAMES[i]}: ${addr}`));

  const groupId = await agents[0]!.createGroup(
    peerAddresses.slice(1) as Hex[],
    "chorus-committee"
  );
  console.log(`\ngroup created: ${groupId.slice(0, 16)}...`);
  await new Promise((r) => setTimeout(r, 2000));

  // broadcast proposal
  console.log(`\nbroadcasting proposal: transfer ${tx.value} wei to ${tx.to}`);
  await agents[0]!.sendToGroup(groupId, {
    type: "frost/propose",
    proposalId,
    proposer: 0,
    transaction: tx,
    rationale: "test transfer",
    timestamp: Date.now(),
  });

  // wait for ceremony to complete
  console.log("\nwaiting for ceremony...");
  await new Promise((r) => setTimeout(r, 30000));

  // check results
  for (let i = 0; i < SIGNERS; i++) {
    const ctx = contexts[i];
    if (ctx) {
      console.log(`[${AGENT_NAMES[i]}] state: ${ctx.state}`);
      if (ctx.result) {
        console.log(`  signature rx: 0x${ctx.result.rx.toString(16).slice(0, 16)}...`);
      }
    }
  }

  // cleanup
  for (const agent of agents) {
    await agent.stop();
  }
  console.log("\ndone.");
}

main().catch(console.error);
