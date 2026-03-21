import {
  createDelegation,
  signDelegation,
  getDeleGatorEnvironment,
  toMetaMaskSmartAccount,
  createCaveatBuilder,
  Implementation,
} from "@metamask/delegation-toolkit";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SWAP_ROUTER, USDC } from "../src/uniswap/client.js";
import { writeFileSync } from "fs";

const ALICE_KEY = (process.env.ALICE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Address;
const RPC_URL = process.env.BASE_SEPOLIA_RPC;
const MAX_USDC = 100_000_000n; // 100 USDC (6 decimals)

async function main() {
  if (!ALICE_KEY || !CONTRACT_ADDRESS) {
    console.error("set ALICE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) and CONTRACT_ADDRESS");
    process.exit(1);
  }

  const account = privateKeyToAccount(ALICE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });

  console.log("alice:", account.address);
  console.log("delegate (AgentConsensus):", CONTRACT_ADDRESS);

  // get delegation environment for base sepolia
  const environment = getDeleGatorEnvironment(baseSepolia.id);
  console.log("delegation environment loaded");

  // create alice's smart account
  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: "chorus-alice-v1",
    signatory: { account, type: "wallet" },
    client: publicClient,
    environment,
  });
  console.log("alice smart account:", smartAccount.address);

  // build caveats
  const caveats = createCaveatBuilder(environment);

  // restrict to uniswap router only
  caveats.addCaveat("allowedTargets", { targets: [SWAP_ROUTER] });

  // restrict ERC-20 transfer amount (USDC)
  caveats.addCaveat("erc20TransferAmount", {
    token: USDC,
    amount: MAX_USDC,
  });

  // create delegation: alice -> AgentConsensus contract
  const delegation = createDelegation({
    to: CONTRACT_ADDRESS,
    from: smartAccount.address,
    caveats,
  });

  console.log("delegation created");
  console.log("  delegate:", delegation.delegate);
  console.log("  delegator:", delegation.delegator);
  console.log("  caveats:", delegation.caveats.length);

  // sign the delegation
  const signedDelegation = await signDelegation({
    delegation,
    account: smartAccount,
    environment,
  });

  console.log("delegation signed");

  // save to file
  const output = {
    delegation: signedDelegation,
    aliceSmartAccount: smartAccount.address,
    agentConsensus: CONTRACT_ADDRESS,
    environment: {
      chainId: baseSepolia.id,
      delegationManagerAddress: environment.DelegationManager,
    },
  };

  writeFileSync("delegation.json", JSON.stringify(output, (_, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));

  console.log("saved to delegation.json");
}

main().catch(console.error);
