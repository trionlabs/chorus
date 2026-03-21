import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  createDelegation,
  Implementation,
  redeemDelegations,
  createExecution,
} from "@metamask/delegation-toolkit";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const ALICE_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4") as Hex;

async function main() {
  if (!ALICE_KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const aliceAccount = privateKeyToAccount(ALICE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account: aliceAccount, chain: baseSepolia, transport: http(RPC) });
  const env = getDeleGatorEnvironment(baseSepolia.id);

  // alice's smart account (already deployed)
  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [aliceAccount.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account: aliceAccount },
    client: publicClient as any,
    environment: env,
  });
  console.log("alice smart account:", smartAccount.address);

  // fund the smart account with some ETH for the test
  const balance = await publicClient.getBalance({ address: smartAccount.address });
  console.log("smart account balance:", formatEther(balance), "ETH");

  if (balance < 100000000000000n) { // < 0.0001 ETH
    console.log("funding smart account...");
    const fundTx = await walletClient.sendTransaction({
      to: smartAccount.address,
      value: 500000000000000n, // 0.0005 ETH
      chain: baseSepolia,
      account: aliceAccount,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
    console.log("funded:", fundTx);
  }

  // create a simple delegation: alice -> AgentConsensus, no caveats (unrestricted)
  console.log("\ncreating unrestricted delegation...");
  const delegation = createDelegation({
    environment: env,
    to: CONTRACT,
    from: smartAccount.address,
    scope: {
      type: "nativeTokenTransferAmount" as const,
      maxAmount: 100000000000000n, // 0.0001 ETH max
    },
  });

  console.log("delegate:", delegation.delegate);
  console.log("delegator:", delegation.delegator);
  console.log("caveats:", delegation.caveats.length);

  // sign with alice's smart account
  const signature = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };
  console.log("signed");

  // test 1: redeem directly using the toolkit's helper
  // this calls DelegationManager from the delegate (AgentConsensus) perspective
  // but the toolkit sends from walletClient, which is alice's EOA, not AgentConsensus
  // so this will fail because msg.sender != delegate

  // test 2: simulate the call from AgentConsensus
  // we need to encode the redeemDelegations call and simulate it from AgentConsensus

  const { encodePermissionContexts } = await import("@metamask/delegation-toolkit/utils");
  const { encodeExecutionCalldatas } = await import("@metamask/delegation-toolkit/utils");

  const permContexts = encodePermissionContexts([[signedDelegation as any]]);

  // simple execution: send 0.00001 ETH to alice's EOA
  const execution = createExecution({
    target: aliceAccount.address,
    value: 10000000000000n, // 0.00001 ETH
    callData: "0x" as Hex,
  });

  const execCalldatas = encodeExecutionCalldatas([[execution]]);
  const mode = ("0x" + "00".repeat(32)) as Hex;

  console.log("\npermission context:", permContexts[0]?.slice(0, 40) + "...");
  console.log("execution calldata:", execCalldatas[0]?.slice(0, 40) + "...");

  // simulate: what happens when AgentConsensus calls DelegationManager.redeemDelegations?
  console.log("\nsimulating redeemDelegations from AgentConsensus...");
  try {
    await publicClient.simulateContract({
      address: env.DelegationManager,
      abi: [{
        name: "redeemDelegations",
        type: "function",
        inputs: [
          { name: "_permissionContexts", type: "bytes[]" },
          { name: "_modes", type: "bytes32[]" },
          { name: "_executionCallDatas", type: "bytes[]" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      }],
      functionName: "redeemDelegations",
      args: [permContexts, [mode], execCalldatas],
      account: CONTRACT as `0x${string}`, // simulate as AgentConsensus (the delegate)
    });
    console.log("simulation PASSED");
  } catch (err: any) {
    const sig4 = err?.cause?.data?.slice(0, 10) ?? err?.cause?.cause?.data?.slice(0, 10) ?? "";
    const msg = err?.cause?.shortMessage ?? err?.shortMessage ?? err?.message ?? "";
    console.log("simulation failed:", msg.slice(0, 300));
    console.log("error sig:", sig4);

  }

  // now do it for real: FROST sign and submit through AgentConsensus
  console.log("\n--- full flow: FROST + delegation ---");

  const { getPublicKey: getFrostPubKey, runLocalCeremony } = await import("../../src/frost/cli.js");
  const { agentConsensusAbi } = await import("../../src/chain/abi.js");

  const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";
  const pk = getFrostPubKey(KEYS_DIR);
  const { encodeAbiParameters, keccak256 } = await import("viem");

  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  const nonce = await publicClient.readContract({
    address: CONTRACT as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "getNonce",
    args: [committeeId],
  }) as bigint;
  console.log("nonce:", nonce);

  // compute the action hash the contract will verify
  const executionHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [env.DelegationManager, permContexts, [mode], execCalldatas]
    )
  );

  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, executionHash, nonce]
    )
  ) as Hex;

  console.log("action hash:", actionHash.slice(0, 18) + "...");

  // frost ceremony
  const sig = runLocalCeremony(KEYS_DIR, [0, 1], actionHash);
  console.log("frost signature produced");

  // alice balance before
  const balBefore = await publicClient.getBalance({ address: aliceAccount.address });

  // submit through AgentConsensus
  console.log("submitting executeDelegated...");
  const txHash = await walletClient.writeContract({
    address: CONTRACT as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "executeDelegated",
    args: [committeeId, env.DelegationManager, permContexts, [mode], execCalldatas, sig.rx, sig.ry, sig.z],
    chain: baseSepolia,
    account: aliceAccount,
  });
  console.log("tx:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("gas:", receipt.gasUsed.toString());

  if (receipt.status === "success") {
    const balAfter = await publicClient.getBalance({ address: aliceAccount.address });
    console.log("\nFULL FLOW SUCCESS:");
    console.log("  FROST consensus verified on-chain");
    console.log("  delegation redeemed through DelegationManager");
    console.log("  ETH transferred from Alice's smart account");
    console.log("  alice EOA balance change:", formatEther(balAfter - balBefore), "ETH (minus gas)");
    console.log("  https://sepolia.basescan.org/tx/" + txHash);
  } else {
    console.log("reverted");
  }
}

main().catch(console.error);
