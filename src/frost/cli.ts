import { execFileSync } from "child_process";
import { mkdtempSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export function safeFrost(
  rootDir: string,
  subcommand: string,
  ...args: string[]
): Buffer {
  return execFileSync(
    "safe-frost",
    ["--root-directory", rootDir, subcommand, ...args],
    { timeout: 15_000 }
  );
}

export function generateKeys(
  rootDir: string,
  threshold: number,
  signers: number
): void {
  safeFrost(
    rootDir,
    "split",
    "--threshold",
    String(threshold),
    "--signers",
    String(signers),
    "--force"
  );
}

export interface PublicKeyInfo {
  address: string;
  px: bigint;
  py: bigint;
}

export function getPublicKey(rootDir: string): PublicKeyInfo {
  const raw = safeFrost(rootDir, "info", "--abi-encode", "public-key");
  const hex = raw.toString("utf-8").trim();
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");

  const address =
    "0x" + bytes.subarray(12, 32).toString("hex");
  const px = BigInt("0x" + bytes.subarray(32, 64).toString("hex"));
  const py = BigInt("0x" + bytes.subarray(64, 96).toString("hex"));

  return { address, px, py };
}

export interface SignatureInfo {
  rx: bigint;
  ry: bigint;
  z: bigint;
}

export function getSignature(rootDir: string): SignatureInfo {
  const raw = safeFrost(rootDir, "info", "--abi-encode", "signature");
  const hex = raw.toString("utf-8").trim();
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");

  const rx = BigInt("0x" + bytes.subarray(0, 32).toString("hex"));
  const ry = BigInt("0x" + bytes.subarray(32, 64).toString("hex"));
  const z = BigInt("0x" + bytes.subarray(64, 96).toString("hex"));

  return { rx, ry, z };
}

export function createCeremonyDir(
  keysDir: string,
  participantIndices: number[]
): string {
  const dir = mkdtempSync(join(tmpdir(), "frost-ceremony-"));
  cpSync(join(keysDir, "key.pub"), join(dir, "key.pub"));
  for (const idx of participantIndices) {
    cpSync(join(keysDir, `key.${idx}`), join(dir, `key.${idx}`));
  }
  return dir;
}

export function cleanupCeremonyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function runLocalCeremony(
  keysDir: string,
  participantIndices: number[],
  messageHex: string
): SignatureInfo {
  const dir = createCeremonyDir(keysDir, participantIndices);
  try {
    for (const idx of participantIndices) {
      safeFrost(dir, "commit", "--share-index", String(idx));
    }
    safeFrost(dir, "prepare", "--message", messageHex);
    for (const idx of participantIndices) {
      safeFrost(dir, "sign", "--share-index", String(idx));
    }
    safeFrost(dir, "aggregate");

    const valid = (() => {
      try {
        safeFrost(dir, "verify");
        return true;
      } catch {
        return false;
      }
    })();
    if (!valid) throw new Error("FROST signature verification failed");

    return getSignature(dir);
  } finally {
    cleanupCeremonyDir(dir);
  }
}
