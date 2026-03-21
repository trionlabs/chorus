import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicKey } from "../src/frost/cli.js";

const PRIVATE_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const RPC = process.env.BASE_RPC ?? "https://mainnet.base.org";
const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const registryAbi = [{
  name: "register",
  type: "function",
  inputs: [{ name: "agentURI", type: "string" }],
  outputs: [{ name: "agentId", type: "uint256" }],
  stateMutability: "nonpayable",
}] as const;

async function main() {
  if (!PRIVATE_KEY) {
    console.error("set DEPLOYER_PRIVATE_KEY");
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC) });

  console.log("registering from:", account.address);

  // get frost committee info
  const pk = getPublicKey(KEYS_DIR);

  // build agent metadata as data URI (no hosting needed)
  const metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Chorus Committee",
    description: "FROST threshold signing committee (2-of-3). Three agents (Guard, Judge, Steward) independently evaluate proposals and collectively produce a single Schnorr signature verified on-chain. Operates within human-delegated ERC-7710 permissions with caveated bounds.",
    image: "",
    properties: {
      threshold: "2-of-3",
      groupPublicKey: pk.address,
      groupPx: "0x" + pk.px.toString(16),
      groupPy: "0x" + pk.py.toString(16),
      contract: "0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4",
      chain: "base-sepolia",
      agents: ["Guard (risk)", "Judge (compliance)", "Steward (operations)"],
      protocol: "FROST RFC 9591",
      verification: "~5600 gas constant",
      coordination: "XMTP E2E encrypted",
      delegation: "ERC-7710 via MetaMask DelegationManager",
    },
    endpoints: {
      web: "https://github.com/trionlabs/chorus",
    },
  };

  const jsonStr = JSON.stringify(metadata);
  const base64 = Buffer.from(jsonStr).toString("base64");
  const dataUri = `data:application/json;base64,${base64}`;

  console.log("metadata:", JSON.stringify(metadata, null, 2));
  console.log("\nregistering on ERC-8004 (Base mainnet)...");

  const txHash = await walletClient.writeContract({
    address: REGISTRY as `0x${string}`,
    abi: registryAbi,
    functionName: "register",
    args: [dataUri],
    chain: base,
    account,
  });

  console.log("tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("https://basescan.org/tx/" + txHash);
}

main().catch(console.error);
