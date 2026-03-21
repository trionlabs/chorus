import {
  createDelegation,
  signDelegation,
  getDeleGatorEnvironment,
} from "@metamask/delegation-toolkit";
import type { Address, Hex } from "viem";
import { SWAP_ROUTER } from "../src/uniswap/client.js";
import { writeFileSync } from "fs";

const ALICE_KEY = (process.env.ALICE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const ALICE_ADDRESS = (process.env.ALICE_ADDRESS ?? "") as Address;
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Address;

async function main() {
  if (!ALICE_KEY || !CONTRACT_ADDRESS || !ALICE_ADDRESS) {
    console.error("set ALICE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY), ALICE_ADDRESS, and CONTRACT_ADDRESS");
    process.exit(1);
  }

  const environment = getDeleGatorEnvironment(84532);
  console.log("delegation environment loaded");
  console.log("DelegationManager:", environment.DelegationManager);

  // create delegation: alice -> AgentConsensus with function call scope
  // restricted to Uniswap Router + exactInputSingle method
  const delegation = createDelegation({
    environment,
    to: CONTRACT_ADDRESS,
    from: ALICE_ADDRESS,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER],
      selectors: ["0x414bf389"], // exactInputSingle(ExactInputSingleParams)
    },
  });

  console.log("delegation created");
  console.log("  delegate:", delegation.delegate);
  console.log("  delegator:", delegation.delegator);
  console.log("  caveats:", delegation.caveats.length);

  // sign the delegation with alice's private key
  const signature = await signDelegation({
    privateKey: ALICE_KEY,
    delegation,
    delegationManager: environment.DelegationManager,
    chainId: 84532,
  });

  const signedDelegation = { ...delegation, signature };

  console.log("delegation signed");

  const output = {
    delegation: signedDelegation,
    aliceAddress: ALICE_ADDRESS,
    agentConsensus: CONTRACT_ADDRESS,
    delegationManager: environment.DelegationManager,
    chainId: 84532,
  };

  writeFileSync("delegation.json", JSON.stringify(output, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));

  console.log("saved to delegation.json");
}

main().catch(console.error);
