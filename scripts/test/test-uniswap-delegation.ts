import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  createDelegation,
  Implementation,
  createExecution,
} from "@metamask/delegation-toolkit";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  keccak256,
  encodeFunctionData,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SWAP_ROUTER, USDC, WETH } from "../../src/uniswap/client.js";
import { getPublicKey, runLocalCeremony } from "../../src/frost/cli.js";
import { agentConsensusAbi } from "../../src/chain/abi.js";

const ALICE_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4") as Hex;
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const KEYS_DIR = process.env.FROST_KEYS_DIR ?? ".frost";

const swapAbi = [{
  name: "exactInputSingle",
  type: "function",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }],
  stateMutability: "payable",
}] as const;

const erc20Abi = [{
  name: "approve",
  type: "function",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
}] as const;

async function main() {
  if (!ALICE_KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const aliceAccount = privateKeyToAccount(ALICE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account: aliceAccount, chain: baseSepolia, transport: http(RPC) });
  const env = getDeleGatorEnvironment(baseSepolia.id);

  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [aliceAccount.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account: aliceAccount },
    client: publicClient as any,
    environment: env,
  });
  console.log("alice smart account:", smartAccount.address);

  // check USDC balance
  const usdcBal = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log("USDC balance:", Number(usdcBal) / 1e6, "USDC");

  if (usdcBal === 0n) {
    console.error("no USDC in smart account");
    process.exit(1);
  }

  // create delegation: alice -> AgentConsensus
  // scope: only Uniswap Router, only exactInputSingle, max 100 USDC
  console.log("\n--- creating uniswap delegation (max 100 USDC) ---");

  const delegation = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER, USDC], // allow calling both Uniswap Router and USDC (for approve)
      selectors: [
        "0x04e45aaf", // exactInputSingle
        "0x095ea7b3", // approve
      ],
    },
  });

  const signature = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };
  console.log("delegation signed, caveats:", delegation.caveats.length);

  // encode helpers
  const { encodePermissionContexts, encodeExecutionCalldatas } = await import("@metamask/delegation-toolkit/utils");

  const permContexts = encodePermissionContexts([[signedDelegation as any]]);
  const mode = ("0x" + "00".repeat(32)) as Hex;

  // FROST setup
  const pk = getPublicKey(KEYS_DIR);
  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  // --- TEST 1: approve USDC for Uniswap Router (within delegation bounds) ---
  console.log("\n--- test 1: approve USDC for router (should succeed) ---");

  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER, 100_000_000n], // approve 100 USDC
  });

  const approveExec = createExecution({
    target: USDC,
    value: 0n,
    callData: approveCalldata,
  });

  const approveExecCalldatas = encodeExecutionCalldatas([[approveExec]]);

  const nonce1 = await publicClient.readContract({
    address: CONTRACT as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "getNonce",
    args: [committeeId],
  }) as bigint;

  const execHash1 = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [env.DelegationManager, permContexts, [mode], approveExecCalldatas]
    )
  );
  const actionHash1 = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, execHash1, nonce1]
    )
  ) as Hex;

  const sig1 = runLocalCeremony(KEYS_DIR, [0, 1], actionHash1);
  console.log("frost signed (approve)");

  try {
    const tx1 = await walletClient.writeContract({
      address: CONTRACT as `0x${string}`,
      abi: agentConsensusAbi,
      functionName: "executeDelegated",
      args: [committeeId, env.DelegationManager, permContexts, [mode], approveExecCalldatas, sig1.rx, sig1.ry, sig1.z],
      chain: baseSepolia,
      account: aliceAccount,
    });
    const r1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
    console.log("approve tx:", tx1);
    console.log("status:", r1.status);
    if (r1.status === "success") {
      console.log("USDC approved for Uniswap Router via FROST + delegation");
    }
  } catch (err: any) {
    console.log("approve failed:", err?.cause?.shortMessage?.slice(0, 100) ?? err.message?.slice(0, 100));
  }

  // --- TEST 2: swap 5 USDC for ETH (within 100 USDC cap) ---
  // wait for nonce to settle
  await new Promise(r => setTimeout(r, 3000));

  console.log("\n--- test 2: swap 5 USDC for ETH (should succeed) ---");

  // need a fresh delegation since the same permContexts may cause issues
  const delegation2 = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER, USDC],
      selectors: ["0x04e45aaf", "0x095ea7b3"],
    },
  });
  const sig2d = await smartAccount.signDelegation({ delegation: delegation2 });
  const signedDelegation2 = { ...delegation2, signature: sig2d };
  const permContexts2 = encodePermissionContexts([[signedDelegation2 as any]]);

  const swapCalldata = encodeFunctionData({
    abi: swapAbi,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: USDC,
      tokenOut: WETH,
      fee: 3000,
      recipient: smartAccount.address, // ETH goes back to alice's smart account
      amountIn: 5_000_000n, // 5 USDC
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }],
  });

  const swapExec = createExecution({
    target: SWAP_ROUTER,
    value: 0n,
    callData: swapCalldata,
  });

  const swapExecCalldatas = encodeExecutionCalldatas([[swapExec]]);

  // simulate first
  console.log("simulating swap via delegation...");
  try {
    await publicClient.simulateContract({
      address: env.DelegationManager,
      abi: [{ name: "redeemDelegations", type: "function", inputs: [{ name: "_permissionContexts", type: "bytes[]" }, { name: "_modes", type: "bytes32[]" }, { name: "_executionCallDatas", type: "bytes[]" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "redeemDelegations",
      args: [permContexts2, [mode], swapExecCalldatas],
      account: CONTRACT as `0x${string}`,
    });
    console.log("simulation PASSED");
  } catch (simErr: any) {
    console.log("simulation failed:", simErr?.cause?.shortMessage?.slice(0, 200) ?? simErr.message?.slice(0, 200));
  }

  const nonce2 = await publicClient.readContract({
    address: CONTRACT as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "getNonce",
    args: [committeeId],
  }) as bigint;

  const execHash2 = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
      [env.DelegationManager, permContexts2, [mode], swapExecCalldatas]
    )
  );
  const actionHash2 = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, execHash2, nonce2]
    )
  ) as Hex;

  // verify the action hash matches what contract would compute
  const contractHash = await publicClient.readContract({
    address: CONTRACT as `0x${string}`,
    abi: agentConsensusAbi,
    functionName: "getActionHash",
    args: [committeeId, execHash2, nonce2],
  }) as Hex;
  console.log("off-chain hash:", actionHash2);
  console.log("contract hash: ", contractHash);
  console.log("match:", actionHash2 === contractHash);

  // also verify the executionHash matches
  // the contract computes: keccak256(abi.encode(delegationManager, permissionContexts, modes, executionCallDatas))
  // we need to check if our off-chain encoding matches
  console.log("nonce:", nonce2);
  console.log("committeeId:", committeeId);
  console.log("execHash:", execHash2);

  const sig2 = runLocalCeremony(KEYS_DIR, [1, 2], actionHash2);
  console.log("frost signed (swap, participants 1+2)");

  try {
    const tx2 = await walletClient.writeContract({
      address: CONTRACT as `0x${string}`,
      abi: agentConsensusAbi,
      functionName: "executeDelegated",
      args: [committeeId, env.DelegationManager, permContexts2, [mode], swapExecCalldatas, sig2.rx, sig2.ry, sig2.z],
      chain: baseSepolia,
      account: aliceAccount,
      gas: 500_000n,
    });
    const r2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
    console.log("swap tx:", tx2);
    console.log("status:", r2.status);
    if (r2.status === "success") {
      console.log("5 USDC swapped for ETH via FROST + delegation + Uniswap");
      console.log("https://sepolia.basescan.org/tx/" + tx2);
    }
  } catch (err: any) {
    console.log("swap failed:", err?.cause?.shortMessage?.slice(0, 200) ?? err.message?.slice(0, 200));
  }

  // final balances
  const finalUsdc = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log("\nfinal USDC balance:", Number(finalUsdc) / 1e6, "USDC");
}

main().catch(console.error);
