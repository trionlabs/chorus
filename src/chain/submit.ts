import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { agentConsensusAbi } from "./abi.js";
import type { SignatureResult } from "../ceremony/types.js";

export interface SubmitConfig {
  contractAddress: Address;
  committeeId: Hex;
  delegationManager: Address;
  walletKey: Hex;
  rpcUrl?: string;
}

export function createSubmitter(config: SubmitConfig) {
  const account = privateKeyToAccount(config.walletKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(config.rpcUrl),
  });

  return {
    async submitDelegated(
      permissionContexts: Hex[],
      modes: Hex[],
      executionCallDatas: Hex[],
      signature: SignatureResult,
    ): Promise<{ txHash: Hex; success: boolean }> {
      const txHash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: agentConsensusAbi,
        functionName: "executeDelegated",
        args: [
          config.committeeId,
          config.delegationManager,
          permissionContexts,
          modes,
          executionCallDatas,
          signature.rx,
          signature.ry,
          signature.z,
        ],
        chain: baseSepolia,
        account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 30_000,
      });

      return {
        txHash,
        success: receipt.status === "success",
      };
    },

    async getNonce(): Promise<bigint> {
      return publicClient.readContract({
        address: config.contractAddress,
        abi: agentConsensusAbi,
        functionName: "getNonce",
        args: [config.committeeId],
      }) as Promise<bigint>;
    },

    async getActionHash(executionHash: Hex, nonce: bigint): Promise<Hex> {
      return publicClient.readContract({
        address: config.contractAddress,
        abi: agentConsensusAbi,
        functionName: "getActionHash",
        args: [config.committeeId, executionHash, nonce],
      }) as Promise<Hex>;
    },
  };
}
