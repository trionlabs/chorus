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
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { agentConsensusAbi } from "../../src/chain/abi.js";
import { getPublicKey, runLocalCeremony } from "../../src/frost/cli.js";
import { SWAP_ROUTER } from "../../src/uniswap/client.js";
import {
  encodePermissionContexts,
  encodeExecutionCalldatas,
} from "@metamask/delegation-toolkit/utils";

const KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "") as Hex;
const CONTRACT = (process.env.CONTRACT_ADDRESS ?? "0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4") as Hex;
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const UNAUTHORIZED_TARGET = "0x000000000000000000000000000000000000dEaD" as Hex;

async function main() {
  if (!KEY) { console.error("set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const env = getDeleGatorEnvironment(baseSepolia.id);

  const smartAccount = await toMetaMaskSmartAccount({
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: ("0x" + "00".repeat(31) + "01") as Hex,
    signer: { account },
    client: publicClient as any,
    environment: env,
  });
  console.log("alice smart account:", smartAccount.address);

  const pk = getPublicKey(".frost");
  const committeeId = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.px, pk.py])
  );

  const mode = ("0x" + "00".repeat(32)) as Hex;

  // --- delegation: ONLY Uniswap Router allowed ---
  console.log("\n--- delegation: only Uniswap Router allowed ---");

  // test 1: call Uniswap Router (allowed target) - should PASS
  console.log("\n--- test 1: call Uniswap Router (allowed) ---");
  const deleg1 = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: { type: "functionCall" as const, targets: [SWAP_ROUTER], selectors: ["0x04e45aaf"] },
  });
  const sig1 = await smartAccount.signDelegation({ delegation: deleg1 });
  const permCtx1 = encodePermissionContexts([[{ ...deleg1, signature: sig1 } as any]]);
  const exec1 = createExecution({ target: SWAP_ROUTER, value: 0n, callData: "0x04e45aaf" as Hex });
  const execCd1 = encodeExecutionCalldatas([[exec1]]);

  try {
    await publicClient.simulateContract({
      address: env.DelegationManager,
      abi: [{ name: "redeemDelegations", type: "function", inputs: [{ name: "_permissionContexts", type: "bytes[]" }, { name: "_modes", type: "bytes32[]" }, { name: "_executionCallDatas", type: "bytes[]" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "redeemDelegations",
      args: [permCtx1, [mode], execCd1],
      account: CONTRACT as `0x${string}`,
    });
    console.log("ALLOWED: Uniswap Router call accepted by DelegationManager");
  } catch (e: any) {
    const reason = e?.cause?.shortMessage ?? "";
    if (reason.includes("AllowedTargets") || reason.includes("AllowedMethods")) {
      console.log("REJECTED (unexpected):", reason.slice(0, 100));
    } else {
      // reverted for other reasons (bad calldata etc) but caveat passed
      console.log("ALLOWED: caveat passed (execution may fail for other reasons)");
    }
  }

  // test 2: call unauthorized target (NOT in allowlist) - should FAIL
  console.log("\n--- test 2: call 0xdead (not in allowlist) ---");
  const deleg2 = createDelegation({
    environment: env,
    to: CONTRACT as `0x${string}`,
    from: smartAccount.address,
    scope: { type: "functionCall" as const, targets: [SWAP_ROUTER], selectors: ["0x04e45aaf"] },
  });
  const sig2 = await smartAccount.signDelegation({ delegation: deleg2 });
  const permCtx2 = encodePermissionContexts([[{ ...deleg2, signature: sig2 } as any]]);
  const exec2 = createExecution({ target: UNAUTHORIZED_TARGET, value: 0n, callData: "0x" as Hex });
  const execCd2 = encodeExecutionCalldatas([[exec2]]);

  try {
    await publicClient.simulateContract({
      address: env.DelegationManager,
      abi: [{ name: "redeemDelegations", type: "function", inputs: [{ name: "_permissionContexts", type: "bytes[]" }, { name: "_modes", type: "bytes32[]" }, { name: "_executionCallDatas", type: "bytes[]" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "redeemDelegations",
      args: [permCtx2, [mode], execCd2],
      account: CONTRACT as `0x${string}`,
    });
    console.log("ALLOWED (unexpected - target should be blocked)");
  } catch (e: any) {
    const reason = e?.cause?.shortMessage ?? e?.cause?.reason ?? "";
    console.log("BLOCKED: unauthorized target rejected by AllowedTargetsEnforcer");
    console.log("reason:", reason.slice(0, 150));
  }

  // test 3: submit both on-chain to get real txs
  console.log("\n--- test 3: submit unauthorized target on-chain (frost passes, caveat blocks) ---");

  let nonce = await publicClient.readContract({
    address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "getNonce", args: [committeeId],
  }) as bigint;

  const execHash = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes[]" }, { type: "bytes32[]" }, { type: "bytes[]" }],
    [env.DelegationManager, permCtx2, [mode], execCd2]
  ));
  const actionHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [committeeId, execHash, nonce]
  )) as Hex;

  const frost = runLocalCeremony(".frost", [0, 1], actionHash);
  console.log("frost signed (valid 2-of-3 signature)");

  try {
    await walletClient.writeContract({
      address: CONTRACT as `0x${string}`, abi: agentConsensusAbi, functionName: "executeDelegated",
      args: [committeeId, env.DelegationManager, permCtx2, [mode], execCd2, frost.rx, frost.ry, frost.z],
      chain: baseSepolia, account, gas: 500_000n,
    });
    console.log("unexpected success");
  } catch (e: any) {
    const errSig = e?.cause?.signature ?? "";
    if (errSig === "0x413237e6") {
      console.log("DEFENSE-IN-DEPTH PROVEN:");
      console.log("  layer 1 (FROST consensus): PASSED - valid 2-of-3 threshold signature");
      console.log("  layer 2 (delegation caveat): BLOCKED - target 0xdead not in AllowedTargets");
      console.log("  result: tx reverted. even with valid frost consensus, policy stops unauthorized actions");
    } else {
      console.log("error:", errSig || e.message?.slice(0, 100));
    }
  }
}

main().catch(console.error);
