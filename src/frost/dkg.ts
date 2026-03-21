import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DKG_BIN = join(__dirname, "../../frost-dkg/target/release/frost-dkg");

interface DkgPart1Result {
  secret_package: string;
  round1_package: string;
}

interface DkgPart2Result {
  secret_package: string;
  round2_packages: Record<string, string>;
}

interface DkgPart3Result {
  key_package: string;
  public_key_package: string;
}

function runDkg(input: object): any {
  const result = execFileSync(DKG_BIN, {
    input: JSON.stringify(input),
    timeout: 15_000,
  });
  const parsed = JSON.parse(result.toString("utf-8"));
  if (parsed.result === "error") {
    throw new Error(`frost-dkg: ${parsed.message}`);
  }
  return parsed;
}

export function dkgPart1(
  identifier: number,
  maxSigners: number,
  minSigners: number,
): DkgPart1Result {
  return runDkg({
    command: "dkg-part1",
    identifier,
    max_signers: maxSigners,
    min_signers: minSigners,
  });
}

export function dkgPart2(
  round1SecretPackage: string,
  round1Packages: Record<number, string>,
): DkgPart2Result {
  return runDkg({
    command: "dkg-part2",
    round1_secret_package: round1SecretPackage,
    round1_packages: round1Packages,
  });
}

export function dkgPart3(
  round2SecretPackage: string,
  round1Packages: Record<number, string>,
  round2Packages: Record<number, string>,
): DkgPart3Result {
  return runDkg({
    command: "dkg-part3",
    round2_secret_package: round2SecretPackage,
    round1_packages: round1Packages,
    round2_packages: round2Packages,
  });
}

// run a full local DKG ceremony (all participants in one process)
export function runLocalDkg(
  threshold: number,
  signers: number,
): { keyPackages: Record<number, string>; publicKeyPackage: string } {
  // identifiers are 1-indexed in FROST
  const ids = Array.from({ length: signers }, (_, i) => i + 1);

  // round 1: each participant generates commitments
  const part1Results: Record<number, DkgPart1Result> = {};
  for (const id of ids) {
    part1Results[id] = dkgPart1(id, signers, threshold);
  }

  // round 2: each participant processes others' round1 packages
  const part2Results: Record<number, DkgPart2Result> = {};
  for (const id of ids) {
    const othersRound1: Record<number, string> = {};
    for (const otherId of ids) {
      if (otherId !== id) {
        othersRound1[otherId] = part1Results[otherId]!.round1_package;
      }
    }
    part2Results[id] = dkgPart2(part1Results[id]!.secret_package, othersRound1);
  }

  // round 3: each participant finalizes with others' round2 shares
  const keyPackages: Record<number, string> = {};
  let publicKeyPackage = "";

  for (const id of ids) {
    const othersRound1: Record<number, string> = {};
    const myRound2Shares: Record<number, string> = {};

    for (const otherId of ids) {
      if (otherId !== id) {
        othersRound1[otherId] = part1Results[otherId]!.round1_package;
        // the share that otherId sent TO me
        myRound2Shares[otherId] = part2Results[otherId]!.round2_packages[String(id)]!;
      }
    }

    const result = dkgPart3(
      part2Results[id]!.secret_package,
      othersRound1,
      myRound2Shares,
    );
    keyPackages[id] = result.key_package;
    publicKeyPackage = result.public_key_package;
  }

  return { keyPackages, publicKeyPackage };
}
