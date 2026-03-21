import { aiEvaluate } from "./ai-evaluator.js";
import { GUARD, JUDGE, STEWARD } from "./config.js";
import type { Hex, Transaction } from "../ceremony/types.js";

const ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";

const smallSwap: Transaction = {
  to: ROUTER as Hex,
  value: 2_000_000n, // 2 USDC
  data: "0x04e45aaf0000000000000000000000000" as Hex, // exactInputSingle with params
};

const largeSwap: Transaction = {
  to: ROUTER as Hex,
  value: 50_000_000n, // 50 USDC
  data: "0x04e45aaf0000000000000000000000000" as Hex,
};

const context = {
  usdcBalance: "12.5 USDC",
  delegationCaveats: "AllowedTargets: Uniswap Router (0x94cC...12bc4) + USDC. AllowedMethods: exactInputSingle (0x04e45aaf) + approve. Max 100 USDC per transaction.",
  recentProposals: 1,
};

async function main() {
  console.log("--- AI evaluator test (with context) ---\n");

  console.log("small swap (2 USDC):");
  for (const role of [GUARD, JUDGE, STEWARD]) {
    const result = await aiEvaluate(smallSwap, role, context);
    console.log(`  [${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);
  }

  console.log("\nlarge swap (50 USDC):");
  for (const role of [GUARD, JUDGE, STEWARD]) {
    const result = await aiEvaluate(largeSwap, role, context);
    console.log(`  [${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);
  }
}

main().catch(console.error);
