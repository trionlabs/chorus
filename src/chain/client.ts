import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export function getPublicClient(
  rpcUrl?: string,
  chain: Chain = baseSepolia
): PublicClient {
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

export function getWalletClient(
  privateKey: `0x${string}`,
  rpcUrl?: string,
  chain: Chain = baseSepolia
): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
}
