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
    swapDescription?: string;
  }
): Promise<AiEvaluation> {
  const swapDesc = context?.swapDescription ?? `call to ${tx.to} with ${tx.value.toString()} raw units`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: role.systemPrompt,
    messages: [
      {
        role: "user",
        content: `Evaluate this proposal for the FROST signing committee.

Proposed action: ${swapDesc}
Target contract: ${tx.to}
Alice's USDC balance: ${context?.usdcBalance ?? "unknown"}
Delegation caveats: ${context?.delegationCaveats ?? "Uniswap Router only, max 100 USDC"}
Recent proposals: ${context?.recentProposals ?? 0}

Respond with exactly one line:
ACCEPT: <reason>
or
REJECT: <reason>`,
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

  return { approved: false, reason: `unclear response: ${text.slice(0, 100)}` };
}
