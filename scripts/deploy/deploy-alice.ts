import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  Implementation,
} from "@metamask/delegation-toolkit";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, getRpcUrl } from "../../src/chain/config.js";

const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;

async function main() {
  if (!KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const chain = getChain();
  const rpcUrl = getRpcUrl(chain);
  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log("chain:", chain.name);

  const env = getDeleGatorEnvironment(chain.id);
  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account },
    client: publicClient as any,
    environment: env,
  });

  console.log("counterfactual:", smartAccount.address);

  const code = await publicClient.getCode({ address: smartAccount.address });
  if (code && code !== "0x") {
    console.log("already deployed");
    return;
  }

  const factoryArgs = await smartAccount.getFactoryArgs();
  if (!factoryArgs?.factory || !factoryArgs?.factoryData) {
    console.error("no factory args");
    return;
  }

  console.log("deploying...");
  const txHash = await walletClient.sendTransaction({
    to: factoryArgs.factory,
    data: factoryArgs.factoryData,
    chain,
    account,
  });
  console.log("tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
}

main().catch(console.error);
