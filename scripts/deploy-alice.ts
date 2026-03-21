import {
  toMetaMaskSmartAccount,
  getDeleGatorEnvironment,
  Implementation,
} from "@metamask/delegation-toolkit";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const ALICE_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

async function main() {
  if (!ALICE_KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const aliceAccount = privateKeyToAccount(ALICE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account: aliceAccount, chain: baseSepolia, transport: http(RPC) });

  const env = getDeleGatorEnvironment(baseSepolia.id);

  const salt = ("0x" + "00".repeat(31) + "01") as Hex;

  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [aliceAccount.address, [], [], []],
    deploySalt: salt,
    signer: { account: aliceAccount },
    client: publicClient as any,
    environment: env,
  });

  console.log("counterfactual address:", smartAccount.address);

  const code = await publicClient.getCode({ address: smartAccount.address });
  if (code && code !== "0x") {
    console.log("already deployed");
    return;
  }

  // get factory args from the smart account
  const factoryArgs = await smartAccount.getFactoryArgs();
  if (!factoryArgs?.factory || !factoryArgs?.factoryData) {
    console.error("no factory args - account may already be deployed");
    return;
  }

  console.log("factory:", factoryArgs.factory);
  console.log("deploying...");

  // deploy by calling the factory directly with the factoryData
  const txHash = await walletClient.sendTransaction({
    to: factoryArgs.factory,
    data: factoryArgs.factoryData,
    chain: baseSepolia,
    account: aliceAccount,
  });

  console.log("tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("gas:", receipt.gasUsed.toString());

  const deployedCode = await publicClient.getCode({ address: smartAccount.address });
  if (deployedCode && deployedCode !== "0x") {
    console.log("deployed at:", smartAccount.address);
    console.log("https://sepolia.basescan.org/address/" + smartAccount.address);
  } else {
    console.log("check tx:", "https://sepolia.basescan.org/tx/" + txHash);
  }
}

main().catch(console.error);
