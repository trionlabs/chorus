import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safeFrost, getSignature, type SignatureInfo } from "./cli.js";

export interface CeremonyDir {
  path: string;
  shareIndex: number;
}

export function createCeremonyDir(
  keysDir: string,
  shareIndex: number
): CeremonyDir {
  const dir = mkdtempSync(join(tmpdir(), "frost-ceremony-"));
  cpSync(join(keysDir, "key.pub"), join(dir, "key.pub"));
  cpSync(join(keysDir, `key.${shareIndex}`), join(dir, `key.${shareIndex}`));
  return { path: dir, shareIndex };
}

export function cleanup(dir: CeremonyDir): void {
  rmSync(dir.path, { recursive: true, force: true });
}

export function commitRound1(dir: CeremonyDir): string {
  safeFrost(dir.path, "commit", "--share-index", String(dir.shareIndex));
  const file = join(dir.path, `round1.${dir.shareIndex}.commitments`);
  return readFileSync(file).toString("hex");
}

export function writeCommitments(
  dir: CeremonyDir,
  peerIndex: number,
  hex: string
): void {
  const file = join(dir.path, `round1.${peerIndex}.commitments`);
  writeFileSync(file, Buffer.from(hex, "hex"));
}

export function prepareSigning(
  dir: CeremonyDir,
  messageHex: string
): string {
  safeFrost(dir.path, "prepare", "--message", messageHex);
  const file = join(dir.path, "round1");
  return readFileSync(file).toString("hex");
}

export function writeSigningPackage(
  dir: CeremonyDir,
  hex: string
): void {
  const file = join(dir.path, "round1");
  writeFileSync(file, Buffer.from(hex, "hex"));
}

export function signRound2(dir: CeremonyDir): string {
  safeFrost(dir.path, "sign", "--share-index", String(dir.shareIndex));
  const file = join(dir.path, `round2.${dir.shareIndex}`);
  return readFileSync(file).toString("hex");
}

export function writeSignatureShare(
  dir: CeremonyDir,
  peerIndex: number,
  hex: string
): void {
  const file = join(dir.path, `round2.${peerIndex}`);
  writeFileSync(file, Buffer.from(hex, "hex"));
}

export function aggregate(dir: CeremonyDir): SignatureInfo {
  safeFrost(dir.path, "aggregate");
  return getSignature(dir.path);
}
