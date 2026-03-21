import "dotenv/config";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generatePrivateKey } from "viem/accounts";
import { dkgPart1, dkgPart2, dkgPart3, writeDkgKeys } from "./frost/dkg.js";
import { getPublicKey, runLocalCeremony } from "./frost/cli.js";
import { ChorusAgent } from "./xmtp/agent.js";
import type { ProtocolMessage } from "./xmtp/messages.js";
import type { Hex } from "./ceremony/types.js";

const THRESHOLD = 2;
const SIGNERS = 3;
const AGENT_NAMES = ["Guard", "Judge", "Steward"];

async function main() {
  console.log("--- chorus DKG over XMTP demo ---\n");

  // per-agent DKG state
  const secrets: Record<number, string> = {};          // round1 secret packages
  const round1Pkgs: Record<number, string> = {};       // round1 broadcast packages
  const round2Secrets: Record<number, string> = {};     // round2 secret packages
  const round2Received: Record<number, Record<number, string>> = {};
  const round1Received: Record<number, Record<number, string>> = {};
  const results: Record<number, { key_package: string; public_key_package: string }> = {};

  for (let i = 0; i < SIGNERS; i++) {
    round2Received[i + 1] = {};
    round1Received[i + 1] = {};
  }

  // generate XMTP wallet keys
  const walletKeys: Hex[] = Array.from({ length: SIGNERS }, () => generatePrivateKey());
  const runDir = mkdtempSync(join(tmpdir(), "chorus-dkg-"));
  const agents: ChorusAgent[] = walletKeys.map((key, i) => {
    const dbPath = join(runDir, `${AGENT_NAMES[i]!.toLowerCase()}.db3`);
    return new ChorusAgent(key, AGENT_NAMES[i]!, dbPath);
  });

  // track completion
  let completedCount = 0;
  const done = new Promise<void>((resolve) => {
    const check = () => { if (completedCount >= SIGNERS) resolve(); };

    // register handlers for each agent
    for (let i = 0; i < SIGNERS; i++) {
      const id = i + 1; // FROST identifiers are 1-indexed
      const agent = agents[i]!;

      // handle dkg/round1 (broadcast)
      agent.on("dkg/round1", async (msg, reply, sendDm) => {
        if (msg.type !== "dkg/round1") return;
        const fromId = msg.signerIndex;
        if (fromId === id) return; // ignore own message
        round1Received[id]![fromId] = msg.commitments;
        console.log(`[${AGENT_NAMES[i]}] received round1 from agent ${fromId}`);

        // check if we have all round1 packages
        if (Object.keys(round1Received[id]!).length === SIGNERS - 1) {
          console.log(`[${AGENT_NAMES[i]}] all round1 received, computing round2...`);
          const part2 = dkgPart2(secrets[id]!, round1Received[id]!);
          round2Secrets[id] = part2.secret_package;

          // send round2 shares via DM (secret - never broadcast to group)
          for (const [peerId, share] of Object.entries(part2.round2_packages)) {
            const peerIdx = Number(peerId) - 1;
            const peerAddress = agents[peerIdx]!.address as Hex;
            console.log(`[${AGENT_NAMES[i]}] sending round2 share to ${AGENT_NAMES[peerIdx]} via DM`);
            await sendDm(peerAddress, {
              type: "dkg/round2",
              ceremonyId: "dkg-demo",
              fromIndex: id,
              toIndex: Number(peerId),
              share,
            });
          }
        }
      });

      // handle dkg/round2 (should be DM only, but for demo we accept from group)
      agent.on("dkg/round2", async (msg, reply, sendDm, isDm) => {
        if (msg.type !== "dkg/round2") return;
        if (msg.toIndex !== id) return; // not for me
        round2Received[id]![msg.fromIndex] = msg.share;
        console.log(`[${AGENT_NAMES[i]}] received round2 share from agent ${msg.fromIndex}${isDm ? " (DM)" : ""}`);

        // check if we have all round2 shares
        if (Object.keys(round2Received[id]!).length === SIGNERS - 1) {
          console.log(`[${AGENT_NAMES[i]}] all round2 received, finalizing...`);
          const part3 = dkgPart3(
            round2Secrets[id]!,
            round1Received[id]!,
            round2Received[id]!,
          );
          results[id] = part3;
          console.log(`[${AGENT_NAMES[i]}] DKG complete - key share derived`);

          await reply({
            type: "dkg/confirm",
            ceremonyId: "dkg-demo",
            signerIndex: id,
            publicKey: part3.public_key_package?.slice(0, 40) + "...",
          });

          completedCount++;
          check();
        }
      });

      // handle dkg/confirm
      agent.on("dkg/confirm", async (msg) => {
        if (msg.type !== "dkg/confirm") return;
        console.log(`[${AGENT_NAMES[i]}] received confirm from agent ${msg.signerIndex}`);
      });
    }
  });

  // start agents
  console.log("starting agents...");
  for (const agent of agents) {
    await agent.start();
  }
  await new Promise((r) => setTimeout(r, 2000));

  const peerAddresses = agents.map((a) => a.address as Hex);
  console.log("\nagent addresses:");
  peerAddresses.forEach((addr, i) => console.log(`  ${AGENT_NAMES[i]}: ${addr}`));

  const groupId = await agents[0]!.createGroup(
    peerAddresses.slice(1) as Hex[],
    "chorus-dkg"
  );
  console.log(`group created: ${groupId.slice(0, 16)}...`);
  await new Promise((r) => setTimeout(r, 2000));

  // round 1: generate ALL round1 packages first, then broadcast
  console.log("\n--- DKG Round 1: generate commitments ---");
  for (let i = 0; i < SIGNERS; i++) {
    const id = i + 1;
    const part1 = dkgPart1(id, SIGNERS, THRESHOLD);
    secrets[id] = part1.secret_package;
    round1Pkgs[id] = part1.round1_package;
    console.log(`[${AGENT_NAMES[i]}] generated round1 commitments`);
  }

  console.log("\n--- DKG Round 1: broadcast commitments ---");
  for (let i = 0; i < SIGNERS; i++) {
    const id = i + 1;
    await agents[i]!.sendToGroup(groupId, {
      type: "dkg/round1",
      ceremonyId: "dkg-demo",
      signerIndex: id,
      commitments: round1Pkgs[id]!,
    });
  }

  // wait for DKG to complete
  console.log("\nwaiting for DKG ceremony...");
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("DKG timeout")), 60000)),
  ]);

  // verify all agents got the same public key
  const pubKeys = Object.values(results).map((r) => r.public_key_package);
  const allSame = pubKeys.every((pk) => pk === pubKeys[0]);
  console.log(`\nall agents agree on public key: ${allSame}`);
  console.log(`public key package: ${pubKeys[0]?.slice(0, 40)}...`);
  console.log(`key shares generated: ${Object.keys(results).length}`);

  // write DKG keys as safe-frost compatible files
  const dkgKeysDir = join(tmpdir(), "chorus-dkg-keys-" + Date.now());
  writeDkgKeys(dkgKeysDir, results as any, pubKeys[0]!);
  const pk = getPublicKey(dkgKeysDir);
  console.log(`\ngroup address: ${pk.address}`);
  console.log(`keys written to: ${dkgKeysDir}`);

  // run a signing ceremony with the DKG-generated keys
  console.log("\n--- signing with DKG keys ---");
  const testMsg = "0x" + "42".repeat(32);
  const sig = runLocalCeremony(dkgKeysDir, [0, 1], testMsg);
  console.log(`signature rx: 0x${sig.rx.toString(16).slice(0, 16)}...`);

  console.log("\nDKG over XMTP -> signing: end-to-end complete.");
  console.log("no single agent ever saw the full private key.");

  for (const agent of agents) {
    await agent.stop();
  }
}

main().catch(console.error);
