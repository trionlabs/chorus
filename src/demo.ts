import "dotenv/config";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeys, getPublicKey, runLocalCeremony } from "./frost/cli.js";
import { evaluate, type Policy } from "./agent/evaluator.js";
import type { Hex, Transaction } from "./ceremony/types.js";
import { encodeAbiParameters, keccak256 } from "viem";

const THRESHOLD = 2;
const SIGNERS = 3;
const AGENTS = ["Guard", "Judge", "Steward"];

async function main() {
  console.log("--- chorus local demo ---\n");

  // 1. generate frost keys
  const keysDir = mkdtempSync(join(tmpdir(), "chorus-keys-"));
  console.log("generating 2-of-3 FROST keys...");
  generateKeys(keysDir, THRESHOLD, SIGNERS);
  const pk = getPublicKey(keysDir);
  console.log(`group pubkey: ${pk.address}`);
  console.log(`px: 0x${pk.px.toString(16).slice(0, 16)}...`);

  // 2. simulate committee registration (would be on-chain)
  const committeeId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [pk.px, pk.py]
    )
  );
  console.log(`committee id: ${committeeId.slice(0, 18)}...`);

  // 3. define a proposal
  const target = "0x000000000000000000000000000000000000dEaD" as Hex;
  const tx: Transaction = {
    to: target,
    value: 1000000000000000n, // 0.001 ETH
    data: "0x" as Hex,
  };

  console.log(`\nproposal: transfer ${tx.value} wei to ${tx.to}`);

  // 4. each agent evaluates
  const policies: Policy[] = [
    { maxValue: 500000000000000n, allowedTargets: [target.toLowerCase()] }, // guard: max 0.0005, will reject
    { maxValue: 10000000000000000n, allowedTargets: [target.toLowerCase()] }, // judge: max 0.01, will accept
    { maxValue: 10000000000000000n, allowedTargets: [target.toLowerCase()] }, // steward: max 0.01, will accept
  ];

  const evaluations = policies.map((policy, i) => {
    const result = evaluate(tx, policy);
    console.log(
      `  ${AGENTS[i]}: ${result.approved ? "ACCEPT" : "REJECT"} - ${result.reason}`
    );
    return result;
  });

  const acceptingIndices = evaluations
    .map((e, i) => (e.approved ? i : -1))
    .filter((i) => i >= 0);

  if (acceptingIndices.length < THRESHOLD) {
    console.log("\nthreshold not met. blocked.");
    return;
  }

  console.log(`\n${acceptingIndices.length}-of-${SIGNERS} approved (threshold: ${THRESHOLD})`);

  // 5. compute action hash (same as contract would)
  const executionHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [target, tx.value, tx.data]
    )
  );
  const actionHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [committeeId, executionHash, 0n]
    )
  );
  console.log(`action hash: ${actionHash.slice(0, 18)}...`);

  // 6. run frost ceremony
  console.log(
    `\nrunning FROST ceremony with participants [${acceptingIndices.join(", ")}]...`
  );
  const sig = runLocalCeremony(keysDir, acceptingIndices, actionHash);
  console.log(`signature:`);
  console.log(`  rx: 0x${sig.rx.toString(16).slice(0, 16)}...`);
  console.log(`  ry: 0x${sig.ry.toString(16).slice(0, 16)}...`);
  console.log(`  z:  0x${sig.z.toString(16).slice(0, 16)}...`);

  console.log("\ndone. would submit to AgentConsensus.executeDelegated() on-chain.");
  console.log("guard dissented. judge and steward approved. one 96-byte signature proves it.");
}

main().catch(console.error);
