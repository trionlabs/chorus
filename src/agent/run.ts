import { ChorusAgent } from "../xmtp/agent.js";
import { createSigningCeremony } from "../ceremony/signing.js";
import {
  createRuntime,
  extractPeerData,
  routeMessage,
  executeActions,
} from "./handler.js";
import { evaluate } from "./evaluator.js";
import { AGENT_ROLES, type AgentRole } from "./config.js";
import type { ProtocolMessage } from "../xmtp/messages.js";
import type { Hex, SigningContext } from "../ceremony/types.js";
import { encodeAbiParameters, keccak256 } from "viem";

interface RunAgentOptions {
  role: AgentRole;
  walletKey: Hex;
  keysDir: string;
  threshold: number;
  totalSigners: number;
  dbPath?: string;
  committeeId: Hex;
  allowedTargets?: string[];
}

export async function runAgent(options: RunAgentOptions): Promise<ChorusAgent> {
  const { role, walletKey, keysDir, threshold, totalSigners, dbPath, committeeId, allowedTargets } = options;

  const policy = {
    ...role.policy,
    allowedTargets: allowedTargets ?? role.policy.allowedTargets,
  };

  const agent = new ChorusAgent(walletKey, role.name, dbPath);

  let ctx: SigningContext | null = null;
  const runtime = createRuntime();
  const config = {
    name: role.name,
    shareIndex: role.shareIndex,
    keysDir,
    threshold,
    totalSigners,
  };

  const processMessage = async (
    msg: ProtocolMessage,
    reply: (r: ProtocolMessage) => Promise<void>,
  ) => {
    if (!ctx) return;
    extractPeerData(runtime, msg);
    const actions = routeMessage(ctx, msg);
    await executeActions(actions, ctx, runtime, config, reply);
  };

  // register signing ceremony handlers
  for (const type of [
    "frost/accept", "frost/reject", "frost/round1",
    "frost/signing-package", "frost/round2",
    "frost/signature", "frost/executed",
  ]) {
    agent.on(type, async (msg, reply) => {
      await processMessage(msg, reply);
    });
  }

  // handle proposals
  agent.on("frost/propose", async (msg, reply) => {
    if (msg.type !== "frost/propose") return;

    const result = evaluate(msg.transaction, policy);
    console.log(`[${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);

    // compute action hash for this proposal
    const executionHash = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
        [msg.transaction.to, msg.transaction.value, msg.transaction.data]
      )
    );
    const actionHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [committeeId, executionHash, 0n]
      )
    ) as Hex;

    ctx = createSigningCeremony(
      {
        proposalId: msg.proposalId,
        proposer: msg.proposer,
        transaction: msg.transaction,
        timestamp: msg.timestamp,
      },
      role.shareIndex,
      threshold,
      totalSigners,
      actionHash,
    );

    if (result.approved) {
      await reply({
        type: "frost/accept",
        proposalId: msg.proposalId,
        signerIndex: role.shareIndex,
        timestamp: Date.now(),
      });
    } else {
      await reply({
        type: "frost/reject",
        proposalId: msg.proposalId,
        signerIndex: role.shareIndex,
        reason: result.reason,
        timestamp: Date.now(),
      });
    }
  });

  await agent.start();
  return agent;
}

// standalone entry point
async function main() {
  const roleName = process.env.AGENT_ROLE?.toLowerCase();
  const walletKey = process.env.AGENT_WALLET_KEY as Hex | undefined;
  const keysDir = process.env.FROST_KEYS_DIR ?? ".frost";
  const committeeId = process.env.COMMITTEE_ID as Hex | undefined;
  const dbPath = process.env.AGENT_DB_PATH;

  if (!roleName || !walletKey || !committeeId) {
    console.error("required env: AGENT_ROLE, AGENT_WALLET_KEY, COMMITTEE_ID");
    console.error("roles: guard, judge, steward");
    process.exit(1);
  }

  const role = AGENT_ROLES.find(r => r.name.toLowerCase() === roleName);
  if (!role) {
    console.error(`unknown role: ${roleName}. use: guard, judge, steward`);
    process.exit(1);
  }

  const allowedTargets = process.env.ALLOWED_TARGETS?.split(",") ?? [];

  const agent = await runAgent({
    role,
    walletKey,
    keysDir,
    threshold: 2,
    totalSigners: 3,
    dbPath,
    committeeId,
    allowedTargets,
  });

  console.log(`[${role.name}] running at ${agent.address}`);
  console.log(`[${role.name}] ${role.description}`);

  process.on("SIGINT", async () => {
    await agent.stop();
    process.exit(0);
  });
}

// run if called directly
const isMain = process.argv[1]?.endsWith("run.ts") || process.argv[1]?.endsWith("run.js");
if (isMain) {
  main().catch(console.error);
}
