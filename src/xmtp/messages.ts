import type { Hex, Transaction } from "../ceremony/types.js";

// -- signing ceremony messages --

export interface FrostPropose {
  type: "frost/propose";
  proposalId: string;
  proposer: number;
  transaction: Transaction;
  rationale: string;
  timestamp: number;
}

export interface FrostAccept {
  type: "frost/accept";
  proposalId: string;
  signerIndex: number;
  reason: string;
  timestamp: number;
}

export interface FrostReject {
  type: "frost/reject";
  proposalId: string;
  signerIndex: number;
  reason: string;
  timestamp: number;
}

export interface FrostRound1 {
  type: "frost/round1";
  proposalId: string;
  signerIndex: number;
  commitments: string;
}

export interface FrostSigningPackage {
  type: "frost/signing-package";
  proposalId: string;
  coordinatorIndex: number;
  signingPackage: string;
  participantIndices: number[];
}

export interface FrostRound2 {
  type: "frost/round2";
  proposalId: string;
  signerIndex: number;
  signatureShare: string;
}

export interface FrostSignature {
  type: "frost/signature";
  proposalId: string;
  coordinatorIndex: number;
  rx: string;
  ry: string;
  z: string;
}

export interface FrostExecuted {
  type: "frost/executed";
  proposalId: string;
  txHash: Hex;
  success: boolean;
}

// -- dkg ceremony messages --

export interface DkgStart {
  type: "dkg/start";
  ceremonyId: string;
  initiatorIndex: number;
  threshold: number;
  totalSigners: number;
}

export interface DkgRound1 {
  type: "dkg/round1";
  ceremonyId: string;
  signerIndex: number;
  commitments: string;
}

export interface DkgRound2 {
  type: "dkg/round2";
  ceremonyId: string;
  fromIndex: number;
  toIndex: number;
  share: string;
}

export interface DkgConfirm {
  type: "dkg/confirm";
  ceremonyId: string;
  signerIndex: number;
  publicKey: string;
}

export type ProtocolMessage =
  | FrostPropose
  | FrostAccept
  | FrostReject
  | FrostRound1
  | FrostSigningPackage
  | FrostRound2
  | FrostSignature
  | FrostExecuted
  | DkgStart
  | DkgRound1
  | DkgRound2
  | DkgConfirm;

const BIGINT_PREFIX = "bigint:";

export function serializeMessage(msg: ProtocolMessage): string {
  return JSON.stringify(msg, (_key, value) =>
    typeof value === "bigint" ? `${BIGINT_PREFIX}${value}` : value
  );
}

export function parseMessage(json: string): ProtocolMessage {
  const obj = JSON.parse(json, (_key, value) => {
    if (typeof value === "string" && value.startsWith(BIGINT_PREFIX)) {
      return BigInt(value.slice(BIGINT_PREFIX.length));
    }
    return value;
  });
  if (!obj || typeof obj.type !== "string") {
    throw new Error("invalid protocol message: missing type");
  }
  return obj as ProtocolMessage;
}
