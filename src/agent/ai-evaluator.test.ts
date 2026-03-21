import { aiEvaluate } from "./ai-evaluator.js";
import { GUARD, JUDGE, STEWARD } from "./config.js";
import type { Hex, Transaction } from "../ceremony/types.js";

const smallSwap: Transaction = {
  to: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Hex, // Uniswap Router
  value: 2_000_000n, // 2 USDC
  data: "0x04e45aaf" as Hex,
};

const largeSwap: Transaction = {
  to: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Hex,
  value: 50_000_000n, // 50 USDC
  data: "0x04e45aaf" as Hex,
};

async function main() {
  console.log("--- AI evaluator test ---\n");

  console.log("small swap (2 USDC):");
  for (const role of [GUARD, JUDGE, STEWARD]) {
    const result = await aiEvaluate(smallSwap, role);
    console.log(`  [${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);
  }

  console.log("\nlarge swap (50 USDC):");
  for (const role of [GUARD, JUDGE, STEWARD]) {
    const result = await aiEvaluate(largeSwap, role);
    console.log(`  [${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`);
  }
}

main().catch(console.error);
