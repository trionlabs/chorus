import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  Implementation,
} from "@metamask/delegation-toolkit";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;

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

  console.log("counterfactual address:", smartAccount.address);

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

  console.log("deploying on Base mainnet...");
  const txHash = await walletClient.sendTransaction({
    to: factoryArgs.factory,
    data: factoryArgs.factoryData,
    chain: base,
    account,
  });

  console.log("tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("https://basescan.org/tx/" + txHash);
}

main().catch(console.error);
