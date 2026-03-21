import {
  createDelegation,
  signDelegation,
  createCaveat,
  getDeleGatorEnvironment,
} from "@metamask/delegation-toolkit";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { SWAP_ROUTER, USDC } from "../../src/uniswap/client.js";
import { writeFileSync } from "fs";

const ALICE_KEY = (process.env.ALICE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const ALICE_ADDRESS = (process.env.ALICE_ADDRESS ?? "") as Address;
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Address;
const MAX_USDC = 100_000_000n; // 100 USDC (6 decimals)

async function main() {
  if (!ALICE_KEY || !CONTRACT_ADDRESS || !ALICE_ADDRESS) {
    console.error("set ALICE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY), ALICE_ADDRESS, and CONTRACT_ADDRESS");
    process.exit(1);
  }

  const env = getDeleGatorEnvironment(84532);
  console.log("delegation environment loaded");
  console.log("DelegationManager:", env.DelegationManager);

  // build caveats manually for maximum control
  const caveats = [
    // caveat 1: only Uniswap Router
    createCaveat(
      env.caveatEnforcers.AllowedTargetsEnforcer,
      encodeAbiParameters([{ type: "address[]" }], [[SWAP_ROUTER]]),
    ),
    // caveat 2: only exactInputSingle method
    createCaveat(
      env.caveatEnforcers.AllowedMethodsEnforcer,
      encodeAbiParameters([{ type: "bytes4[]" }], [["0x04e45aaf"]]),
    ),
    // caveat 3: max 100 USDC transfer amount
    createCaveat(
      env.caveatEnforcers.ERC20TransferAmountEnforcer,
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [USDC, MAX_USDC],
      ),
    ),
  ];

  const delegation = createDelegation({
    environment: env,
    to: CONTRACT_ADDRESS,
    from: ALICE_ADDRESS,
    caveats,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER],
      selectors: ["0x04e45aaf"],
    },
  });

  console.log("delegation created");
  console.log("  delegate:", delegation.delegate);
  console.log("  delegator:", delegation.delegator);
  console.log("  caveats:", delegation.caveats.length);

  for (const c of delegation.caveats) {
    const enforcerName = Object.entries(env.caveatEnforcers)
      .find(([, addr]) => addr.toLowerCase() === c.enforcer.toLowerCase())?.[0] ?? "unknown";
    console.log(`    ${enforcerName}: ${c.enforcer.slice(0, 18)}...`);
  }

  const signature = await signDelegation({
    privateKey: ALICE_KEY,
    delegation,
    delegationManager: env.DelegationManager,
    chainId: 84532,
  });

  const signedDelegation = { ...delegation, signature };

  const output = {
    delegation: signedDelegation,
    aliceAddress: ALICE_ADDRESS,
    agentConsensus: CONTRACT_ADDRESS,
    delegationManager: env.DelegationManager,
    chainId: 84532,
    caveats: {
      allowedTargets: [SWAP_ROUTER],
      allowedMethods: ["exactInputSingle"],
      maxUsdc: MAX_USDC.toString(),
    },
  };

  writeFileSync("delegation.json", JSON.stringify(output, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));

  console.log("saved to delegation.json");
}

main().catch(console.error);
