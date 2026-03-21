import Anthropic from "@anthropic-ai/sdk";
import type { Transaction } from "../ceremony/types.js";
import type { AgentRole } from "./config.js";

const client = new Anthropic();

export interface AiEvaluation {
  approved: boolean;
  reason: string;
}

export async function aiEvaluate(
  tx: Transaction,
  role: AgentRole,
  context?: {
    usdcBalance?: string;
    delegationCaveats?: string;
    recentProposals?: number;
  }
): Promise<AiEvaluation> {
  const contextBlock = context
    ? `
Current state:
- Alice's USDC balance: ${context.usdcBalance ?? "unknown"}
- Delegation caveats: ${context.delegationCaveats ?? "Uniswap Router only, max 100 USDC, exactInputSingle + approve only"}
- Recent proposals in last 10 min: ${context.recentProposals ?? 0}`
    : "";

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: role.systemPrompt,
    messages: [
      {
        role: "user",
        content: `Evaluate this proposal for the FROST signing committee.

Transaction:
- target: ${tx.to}
- value: ${tx.value.toString()} (raw units)
- data: ${tx.data.slice(0, 20)}${tx.data.length > 20 ? "..." : ""} (${tx.data.length / 2 - 1} bytes)
${contextBlock}

Respond with exactly one line:
ACCEPT: <your reason>
or
REJECT: <your reason>

Be specific in your reasoning. One line only.`,
      },
    ],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

  if (text.startsWith("ACCEPT:")) {
    return { approved: true, reason: text.slice(7).trim() };
  }
  if (text.startsWith("REJECT:")) {
    return { approved: false, reason: text.slice(7).trim() };
  }

  // fallback: if Claude doesn't follow format, treat as rejection (safe default)
  return { approved: false, reason: `unclear response: ${text.slice(0, 100)}` };
}
