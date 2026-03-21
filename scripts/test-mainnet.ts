import { getPublicKey, runLocalCeremony } from "../src/frost/cli.js";
import { agentConsensusAbi } from "../src/chain/abi.js";
import {
  encodeAbiParameters,
  keccak256,
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CONTRACT = "0xEE185FD094A4624B95120CBa8180c92f51794162" as Hex;
const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;

async function main() {
  if (!KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

  const pk = getPublicKey(".frost");
  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  const nonce = await publicClient.readContract({
    address: CONTRACT,
    abi: agentConsensusAbi,
    functionName: "getNonce",
    args: [committeeId],
  }) as bigint;
  console.log("nonce:", nonce);

  // mock delegation (EOA as DM - call succeeds)
  const dm = account.address;
  const ctx = ["0xdead"] as Hex[];
  const modes = [("0x" + "00".repeat(32)) as Hex];
  const exec = ["0xcafe"] as Hex[];

  const execHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [dm, ctx, modes, exec]
    )
  );
  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, execHash, nonce]
    )
  ) as Hex;

  console.log("running FROST ceremony (participants 0, 2)...");
  const sig = runLocalCeremony(".frost", [0, 2], actionHash);
  console.log("signature produced");

  console.log("submitting to Base mainnet...");
  const tx = await walletClient.writeContract({
    address: CONTRACT,
    abi: agentConsensusAbi,
    functionName: "executeDelegated",
    args: [committeeId, dm, ctx, modes, exec, sig.rx, sig.ry, sig.z],
    chain: base,
    account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx);
  console.log("status:", receipt.status);
  console.log("gas:", receipt.gasUsed.toString());
  console.log("https://basescan.org/tx/" + tx);
}

main().catch(console.error);
