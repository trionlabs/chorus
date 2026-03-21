import "dotenv/config";
import { aiEvaluate } from "./ai-evaluator.js";
import { GUARD, JUDGE, STEWARD } from "./config.js";
import type { Hex, Transaction } from "../ceremony/types.js";

const ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";

const tx: Transaction = {
  to: ROUTER as Hex,
  value: 500_000n,
  data: "0x04e45aaf0000000000000000000000000" as Hex,
};

const context = {
  swapDescription: "swap 0.5 USDC for WETH on Uniswap V3 via exactInputSingle",
  usdcBalance: "1.5 USDC",
  delegationCaveats: "AllowedTargets: Uniswap Router + USDC. AllowedMethods: exactInputSingle + approve. Max 100 USDC per tx.",
  recentProposals: 0,
};

async function main() {
  console.log("--- AI evaluator test ---\n");

  for (const role of [GUARD, JUDGE, STEWARD]) {
    const result = await aiEvaluate(tx, role, context);
    console.log(`[${role.name}] ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}\n`);
  }
}

main().catch(console.error);
