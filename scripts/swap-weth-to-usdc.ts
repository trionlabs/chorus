import "dotenv/config";
import {
  toMetaMaskSmartAccount, getDeleGatorEnvironment, createDelegation,
  Implementation, createExecution,
} from "@metamask/delegation-toolkit";
import { encodePermissionContexts, encodeExecutionCalldatas } from "@metamask/delegation-toolkit/utils";
import {
  createPublicClient, createWalletClient, http, encodeAbiParameters,
  encodeFunctionData, keccak256, type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { agentConsensusAbi } from "../src/chain/abi.js";
import { getPublicKey, runLocalCeremony } from "../src/frost/cli.js";

const KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const CONTRACT = "0xEE185FD094A4624B95120CBa8180c92f51794162" as Hex;
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Hex;
const WETH = "0x4200000000000000000000000000000000000006" as Hex;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;

async function main() {
  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const wallet = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });
  const env = getDeleGatorEnvironment(base.id);
  const sa = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account }, client: pub as any, environment: env,
  });

  const pk = getPublicKey(".frost");
  const committeeId = keccak256(encodeAbiParameters([{type:"uint256"},{type:"uint256"}], [pk.px, pk.py]));
  const mode = ("0x" + "00".repeat(32)) as Hex;

  // approve WETH
  const d1 = createDelegation({ environment: env, to: CONTRACT as `0x${string}`, from: sa.address,
    scope: { type: "functionCall" as const, targets: [ROUTER, WETH, USDC], selectors: ["0x04e45aaf", "0x095ea7b3"] }
  });
  const s1 = await sa.signDelegation({ delegation: d1 });
  const pc1 = encodePermissionContexts([[{...d1, signature: s1} as any]]);
  const approveData = encodeFunctionData({ abi: [{name:"approve",type:"function",inputs:[{name:"s",type:"address"},{name:"a",type:"uint256"}],outputs:[{name:"",type:"bool"}],stateMutability:"nonpayable"}], functionName: "approve", args: [ROUTER, 10000000000000000n] });
  const ecd1 = encodeExecutionCalldatas([[createExecution({ target: WETH, value: 0n, callData: approveData })]]);

  let nonce = await pub.readContract({ address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId] }) as bigint;
  let eh = keccak256(encodeAbiParameters([{type:"address"},{type:"bytes[]"},{type:"bytes32[]"},{type:"bytes[]"}], [env.DelegationManager, pc1, [mode], ecd1]));
  let ah = keccak256(encodeAbiParameters([{type:"bytes32"},{type:"bytes32"},{type:"uint256"}], [committeeId, eh, nonce])) as Hex;
  let frost = runLocalCeremony(".frost", [0, 1], ah);
  let tx = await wallet.writeContract({ address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "executeDelegated", args: [committeeId, env.DelegationManager, pc1, [mode], ecd1, frost.rx, frost.ry, frost.z], chain: base, account });
  let r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("approve WETH:", r.status);

  await new Promise(r => setTimeout(r, 3000));

  // swap 0.005 WETH -> USDC
  const d2 = createDelegation({ environment: env, to: CONTRACT as `0x${string}`, from: sa.address,
    scope: { type: "functionCall" as const, targets: [ROUTER, WETH, USDC], selectors: ["0x04e45aaf", "0x095ea7b3"] }
  });
  const s2 = await sa.signDelegation({ delegation: d2 });
  const pc2 = encodePermissionContexts([[{...d2, signature: s2} as any]]);
  const swapData = encodeFunctionData({ abi: [{name:"exactInputSingle",type:"function",stateMutability:"payable",inputs:[{name:"params",type:"tuple",components:[{name:"tokenIn",type:"address"},{name:"tokenOut",type:"address"},{name:"fee",type:"uint24"},{name:"recipient",type:"address"},{name:"amountIn",type:"uint256"},{name:"amountOutMinimum",type:"uint256"},{name:"sqrtPriceLimitX96",type:"uint160"}]}],outputs:[{name:"",type:"uint256"}]}], functionName: "exactInputSingle", args: [{ tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: sa.address, amountIn: 5000000000000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const ecd2 = encodeExecutionCalldatas([[createExecution({ target: ROUTER, value: 0n, callData: swapData })]]);

  nonce = await pub.readContract({ address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId] }) as bigint;
  eh = keccak256(encodeAbiParameters([{type:"address"},{type:"bytes[]"},{type:"bytes32[]"},{type:"bytes[]"}], [env.DelegationManager, pc2, [mode], ecd2]));
  ah = keccak256(encodeAbiParameters([{type:"bytes32"},{type:"bytes32"},{type:"uint256"}], [committeeId, eh, nonce])) as Hex;
  frost = runLocalCeremony(".frost", [0, 2], ah);
  tx = await wallet.writeContract({ address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "executeDelegated", args: [committeeId, env.DelegationManager, pc2, [mode], ecd2, frost.rx, frost.ry, frost.z], chain: base, account, gas: 500000n });
  r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("swap WETH->USDC:", r.status);
  console.log("https://basescan.org/tx/" + tx);

  const finalUsdc = await pub.readContract({ address: USDC, abi: [{name:"balanceOf",type:"function",inputs:[{name:"",type:"address"}],outputs:[{name:"",type:"uint256"}],stateMutability:"view"}], functionName: "balanceOf", args: [sa.address] }) as bigint;
  console.log("USDC balance:", Number(finalUsdc) / 1e6);
}

main().catch(console.error);
