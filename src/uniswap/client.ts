import { encodeFunctionData, type Address, type Hex } from "viem";

// Uniswap V3 SwapRouter02 on Base Sepolia
export const SWAP_ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address;
// USDC on Base Sepolia
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
// WETH on Base Sepolia (wrapped native)
export const WETH = "0x4200000000000000000000000000000000000006" as Address;
// SwapRouter02 exactInputSingle selector (7-field tuple, no deadline)
export const EXACT_INPUT_SINGLE_SELECTOR = "0x04e45aaf" as Hex;
// ERC-20 approve selector
export const APPROVE_SELECTOR = "0x095ea7b3" as Hex;

const swapRouterAbi = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [
      {
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
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

export interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  recipient: Address;
  fee?: number;
  slippageBps?: number;
}

export interface SwapCalldata {
  to: Address;
  data: Hex;
  value: bigint;
}

export function buildSwapCalldata(params: SwapParams): SwapCalldata {
  const fee = params.fee ?? 3000; // 0.3% default
  const data = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee,
        recipient: params.recipient,
        amountIn: params.amountIn,
        amountOutMinimum: 0n, // demo only - production needs real slippage
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  return {
    to: SWAP_ROUTER,
    data,
    value: params.tokenIn === WETH ? params.amountIn : 0n,
  };
}

// ERC-20 approve for Permit2/Router
const erc20ApproveAbi = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export function buildApproveCalldata(
  token: Address,
  spender: Address,
  amount: bigint
): SwapCalldata {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: 0n,
  };
}
