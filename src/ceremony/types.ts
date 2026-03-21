export type Hex = `0x${string}`;

export enum SigningState {
  EVALUATING = "EVALUATING",
  ACCEPTED = "ACCEPTED",
  ROUND1_COMMITTED = "ROUND1_COMMITTED",
  ROUND2_SIGNED = "ROUND2_SIGNED",
  EXECUTING = "EXECUTING",
  COMPLETE = "COMPLETE",
  ABORTED = "ABORTED",
}

export interface Transaction {
  to: Hex;
  value: bigint;
  data: Hex;
}

export interface Proposal {
  proposalId: string;
  proposer: number;
  transaction: Transaction;
  timestamp: number;
}

export interface SigningContext {
  proposalId: string;
  state: SigningState;
  mySignerIndex: number;
  threshold: number;
  totalSigners: number;
  proposal: Proposal;
  acceptedIndices: Set<number>;
  rejectedIndices: Set<number>;
  round1Commitments: Map<number, string>;
  round2Shares: Map<number, string>;
  coordinatorIndex: number | null;
  timeoutAt: number | null;
  messageHash: Hex | null;
  result: SignatureResult | null;
}

export interface SignatureResult {
  rx: bigint;
  ry: bigint;
  z: bigint;
}

export enum ActionType {
  INVOKE_FROST = "INVOKE_FROST",
  SUBMIT_TX = "SUBMIT_TX",
  ABORT = "ABORT",
  COMPLETE = "COMPLETE",
}

export type FrostCommand =
  | { op: "commit"; shareIndex: number }
  | { op: "prepare"; message: Hex; commitments: Map<number, string> }
  | { op: "sign"; shareIndex: number }
  | { op: "aggregate"; shares: Map<number, string> };

export type CeremonyAction =
  | { type: ActionType.INVOKE_FROST; command: FrostCommand }
  | { type: ActionType.SUBMIT_TX; signature: SignatureResult }
  | { type: ActionType.ABORT; reason: string }
  | { type: ActionType.COMPLETE; result: SignatureResult };

export const ROUND_TIMEOUT_MS = 30_000;
