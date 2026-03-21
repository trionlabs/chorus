import { getPublicClient, getWalletClient } from "../src/chain/client.js";
import { agentConsensusAbi } from "../src/chain/abi.js";
import { getPublicKey } from "../src/frost/cli.js";
import type { Address, Hex } from "viem";

const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Address;
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";
const RPC_URL = process.env.BASE_SEPOLIA_RPC;

async function main() {
  if (!CONTRACT_ADDRESS || !DEPLOYER_KEY) {
    console.error("set CONTRACT_ADDRESS and DEPLOYER_PRIVATE_KEY");
    process.exit(1);
  }

  const publicClient = getPublicClient(RPC_URL);
  const walletClient = getWalletClient(DEPLOYER_KEY, RPC_URL);

  const pk = getPublicKey(KEYS_DIR);
  console.log(`group pubkey: ${pk.address}`);
  console.log(`px: 0x${pk.px.toString(16)}`);
  console.log(`py: 0x${pk.py.toString(16)}`);

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: agentConsensusAbi,
    functionName: "registerCommittee",
    args: [pk.px, pk.py, 2n],
  });

  console.log(`tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}`);

  if (receipt.logs.length > 0) {
    console.log(`committee registered in block ${receipt.blockNumber}`);
  }
}

main().catch(console.error);
