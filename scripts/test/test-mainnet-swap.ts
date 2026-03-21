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
  encodeFunctionData,
  keccak256,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { agentConsensusAbi } from "../../src/chain/abi.js";
import { getPublicKey, runLocalCeremony } from "../../src/frost/cli.js";
import {
  encodePermissionContexts,
  encodeExecutionCalldatas,
} from "@metamask/delegation-toolkit/utils";

const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const CONTRACT = "0xEE185FD094A4624B95120CBa8180c92f51794162" as Hex;
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;
const SWAP_ROUTER_MAINNET = "0x2626664c2603336E57B271c5C0b26F421741e481" as Hex; // SwapRouter02 on Base mainnet
const WETH_MAINNET = "0x4200000000000000000000000000000000000006" as Hex;

const swapAbi = [{
  name: "exactInputSingle", type: "function", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ]}],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const erc20Abi = [{
  name: "approve", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

async function main() {
  if (!KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });
  const env = getDeleGatorEnvironment(base.id);

  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account },
    client: publicClient as any,
    environment: env,
  });
  console.log("alice smart account:", smartAccount.address);

  // check USDC balance
  const usdcBal = await publicClient.readContract({
    address: USDC_MAINNET,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log("USDC balance:", Number(usdcBal) / 1e6);

  const pk = getPublicKey(".frost");
  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  // --- step 1: approve USDC for Uniswap Router ---
  console.log("\n--- approve USDC for router ---");

  const approveDeleg = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER_MAINNET, USDC_MAINNET],
      selectors: ["0x04e45aaf", "0x095ea7b3"],
    },
  });
  const approveSig = await smartAccount.signDelegation({ delegation: approveDeleg });
  const signedApproveDeleg = { ...approveDeleg, signature: approveSig };
  const approvePermCtx = encodePermissionContexts([[signedApproveDeleg as any]]);

  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER_MAINNET, 100_000_000n],
  });
  const approveExec = createExecution({ target: USDC_MAINNET, value: 0n, callData: approveCalldata });
  const approveExecCd = encodeExecutionCalldatas([[approveExec]]);
  const mode = ("0x" + "00".repeat(32)) as Hex;

  let nonce = await publicClient.readContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  }) as bigint;

  const approveExecHash = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
    [env.DelegationManager, approvePermCtx, [mode], approveExecCd]
  ));
  const approveActionHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [committeeId, approveExecHash, nonce]
  )) as Hex;

  const approveFrost = runLocalCeremony(".frost", [0, 1], approveActionHash);
  console.log("frost signed (approve)");

  const approveTx = await walletClient.writeContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "executeDelegated",
    args: [committeeId, env.DelegationManager, approvePermCtx, [mode], approveExecCd, approveFrost.rx, approveFrost.ry, approveFrost.z],
    chain: base, account,
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log("approve:", approveTx, approveReceipt.status);

  await new Promise(r => setTimeout(r, 3000));

  // --- step 2: swap 2 USDC for WETH ---
  console.log("\n--- swap 2 USDC for WETH ---");

  const swapDeleg = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: {
      type: "functionCall" as const,
      targets: [SWAP_ROUTER_MAINNET, USDC_MAINNET],
      selectors: ["0x04e45aaf", "0x095ea7b3"],
    },
  });
  const swapDelegSig = await smartAccount.signDelegation({ delegation: swapDeleg });
  const signedSwapDeleg = { ...swapDeleg, signature: swapDelegSig };
  const swapPermCtx = encodePermissionContexts([[signedSwapDeleg as any]]);

  const swapCalldata = encodeFunctionData({
    abi: swapAbi,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: USDC_MAINNET, tokenOut: WETH_MAINNET, fee: 500,
      recipient: smartAccount.address,
      amountIn: 2_000_000n, // 2 USDC
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
  });
  const swapExec = createExecution({ target: SWAP_ROUTER_MAINNET, value: 0n, callData: swapCalldata });
  const swapExecCd = encodeExecutionCalldatas([[swapExec]]);

  nonce = await publicClient.readContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  }) as bigint;

  const swapExecHash = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
    [env.DelegationManager, swapPermCtx, [mode], swapExecCd]
  ));
  const swapActionHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [committeeId, swapExecHash, nonce]
  )) as Hex;

  const swapFrost = runLocalCeremony(".frost", [1, 2], swapActionHash);
  console.log("frost signed (swap, participants 1+2)");

  const swapTx = await walletClient.writeContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "executeDelegated",
    args: [committeeId, env.DelegationManager, swapPermCtx, [mode], swapExecCd, swapFrost.rx, swapFrost.ry, swapFrost.z],
    chain: base, account, gas: 500_000n,
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });
  console.log("swap:", swapTx, swapReceipt.status);
  console.log("https://basescan.org/tx/" + swapTx);

  // final balance
  const finalUsdc = await publicClient.readContract({
    address: USDC_MAINNET,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [smartAccount.address],
  }) as bigint;
  console.log("\nfinal USDC:", Number(finalUsdc) / 1e6);
}

main().catch(console.error);
