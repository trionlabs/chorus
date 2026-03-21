import { base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export function getChain(): Chain {
  const chainArg = process.argv.includes("--mainnet") || process.env.CHAIN === "mainnet";
  return chainArg ? base : baseSepolia;
}

export function getRpcUrl(chain: Chain): string {
  if (chain.id === base.id) return process.env.BASE_RPC ?? "https://mainnet.base.org";
  return process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
}
