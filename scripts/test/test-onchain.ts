import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { agentConsensusAbi } from "../../src/chain/abi.js";
import { runLocalCeremony, getPublicKey } from "../../src/frost/cli.js";

const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4") as Address;
const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";

async function main() {
  if (!KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

  const pk = getPublicKey(KEYS_DIR);
  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  // read current nonce
  const nonce = await publicClient.readContract({
    address: CONTRACT, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  });
  console.log("committee nonce:", nonce);

  // build a mock delegation call (just to test FROST verification on-chain)
  // use deployer address as mock delegation manager that will receive the call
  const mockDM = account.address;
  const permissionContexts: Hex[] = ["0xdead"];
  const modes: Hex[] = [("0x" + "00".repeat(32)) as Hex];
  const executionCallDatas: Hex[] = ["0xcafe"];

  const executionHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [mockDM, permissionContexts, modes, executionCallDatas]
    )
  );

  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, executionHash, nonce]
    )
  );
  console.log("action hash:", actionHash);

  // frost ceremony
  console.log("running FROST ceremony (participants 0, 1)...");
  const sig = runLocalCeremony(KEYS_DIR, [0, 1], actionHash);
  console.log("signature rx:", "0x" + sig.rx.toString(16).slice(0, 16) + "...");

  // submit on-chain
  console.log("submitting executeDelegated...");
  const txHash = await walletClient.writeContract({
    address: CONTRACT,
    abi: agentConsensusAbi,
    functionName: "executeDelegated",
    args: [committeeId, mockDM, permissionContexts, modes, executionCallDatas, sig.rx, sig.ry, sig.z],
  });
  console.log("tx:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("gas used:", receipt.gasUsed.toString());
  console.log("block:", receipt.blockNumber);

  if (receipt.status === "success") {
    console.log("\nFROST signature verified on-chain. committee consensus proven.");
    console.log("explorer: https://sepolia.basescan.org/tx/" + txHash);
  } else {
    console.error("transaction reverted!");
  }

  // check nonce incremented
  const newNonce = await publicClient.readContract({
    address: CONTRACT, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  });
  console.log("new nonce:", newNonce);
}

main().catch(console.error);
