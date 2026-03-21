import { getChain, getRpcUrl } from "../../src/chain/config.js";
import { agentConsensusAbi } from "../../src/chain/abi.js";
import { getPublicKey } from "../../src/frost/cli.js";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? "") as Address;
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";

async function main() {
  if (!CONTRACT_ADDRESS || !DEPLOYER_KEY) {
    console.error("set CONTRACT_ADDRESS and DEPLOYER_PRIVATE_KEY");
    process.exit(1);
  }

  const chain = getChain();
  const rpcUrl = getRpcUrl(chain);
  const account = privateKeyToAccount(DEPLOYER_KEY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log("chain:", chain.name);

  const pk = getPublicKey(KEYS_DIR);
  console.log("group pubkey:", pk.address);

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: agentConsensusAbi,
    functionName: "registerCommittee",
    args: [pk.px, pk.py, 2n],
    chain,
    account,
  });

  console.log("tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status);
}

main().catch(console.error);
