import {
  SigningState,
  ActionType,
  ROUND_TIMEOUT_MS,
  type SigningContext,
  type CeremonyAction,
  type Proposal,
  type Hex,
} from "./types.js";

export function createSigningCeremony(
  proposal: Proposal,
  mySignerIndex: number,
  threshold: number,
  totalSigners: number,
  messageHash?: Hex
): SigningContext {
  return {
    proposalId: proposal.proposalId,
    state: SigningState.EVALUATING,
    mySignerIndex,
    threshold,
    totalSigners,
    proposal,
    acceptedIndices: new Set(),
    rejectedIndices: new Set(),
    round1Commitments: new Map(),
    round2Shares: new Map(),
    coordinatorIndex: null,
    timeoutAt: null,
    messageHash: messageHash ?? null,
    result: null,
  };
}

export function handleAccept(
  ctx: SigningContext,
  signerIndex: number
): CeremonyAction[] {
  if (
    ctx.state !== SigningState.EVALUATING &&
    ctx.state !== SigningState.ACCEPTED
  )
    return [];

  ctx.acceptedIndices.add(signerIndex);

  const sorted = [...ctx.acceptedIndices].sort((a, b) => a - b);
  ctx.coordinatorIndex = sorted[0]!;

  if (
    ctx.acceptedIndices.size >= ctx.threshold &&
    ctx.state === SigningState.EVALUATING
  ) {
    ctx.state = SigningState.ACCEPTED;
    ctx.timeoutAt = Date.now() + ROUND_TIMEOUT_MS;

    if (ctx.acceptedIndices.has(ctx.mySignerIndex)) {
      return [
        {
          type: ActionType.INVOKE_FROST,
          command: { op: "commit", shareIndex: ctx.mySignerIndex },
        },
      ];
    }
  }
  return [];
}

export function handleReject(
  ctx: SigningContext,
  signerIndex: number,
  reason: string
): CeremonyAction[] {
  if (ctx.state !== SigningState.EVALUATING) return [];

  ctx.rejectedIndices.add(signerIndex);
  const remaining = ctx.totalSigners - ctx.rejectedIndices.size;

  if (remaining < ctx.threshold) {
    ctx.state = SigningState.ABORTED;
    return [{ type: ActionType.ABORT, reason: `rejected by ${signerIndex}: ${reason}` }];
  }
  return [];
}

export function handleRound1(
  ctx: SigningContext,
  signerIndex: number,
  commitments: string
): CeremonyAction[] {
  if (
    ctx.state !== SigningState.ACCEPTED &&
    ctx.state !== SigningState.ROUND1_COMMITTED
  )
    return [];

  ctx.round1Commitments.set(signerIndex, commitments);

  if (
    ctx.round1Commitments.size >= ctx.threshold &&
    ctx.coordinatorIndex === ctx.mySignerIndex &&
    ctx.state === SigningState.ACCEPTED
  ) {
    ctx.state = SigningState.ROUND1_COMMITTED;
    ctx.timeoutAt = Date.now() + ROUND_TIMEOUT_MS;

    if (!ctx.messageHash) {
      return [{ type: ActionType.ABORT, reason: "no messageHash set" }];
    }

    return [
      {
        type: ActionType.INVOKE_FROST,
        command: {
          op: "prepare",
          message: ctx.messageHash,
          commitments: new Map(ctx.round1Commitments),
        },
      },
    ];
  }
  return [];
}

export function handleSigningPackage(
  ctx: SigningContext,
  participantIndices: number[]
): CeremonyAction[] {
  if (
    ctx.state !== SigningState.ACCEPTED &&
    ctx.state !== SigningState.ROUND1_COMMITTED
  )
    return [];

  ctx.state = SigningState.ROUND1_COMMITTED;
  ctx.timeoutAt = Date.now() + ROUND_TIMEOUT_MS;

  const isParticipant = participantIndices.includes(ctx.mySignerIndex);
  if (isParticipant) {
    return [
      {
        type: ActionType.INVOKE_FROST,
        command: { op: "sign", shareIndex: ctx.mySignerIndex },
      },
    ];
  }
  return [];
}

export function handleRound2(
  ctx: SigningContext,
  signerIndex: number,
  signatureShare: string
): CeremonyAction[] {
  if (
    ctx.state !== SigningState.ROUND1_COMMITTED &&
    ctx.state !== SigningState.ROUND2_SIGNED
  )
    return [];

  ctx.round2Shares.set(signerIndex, signatureShare);

  if (
    ctx.round2Shares.size >= ctx.threshold &&
    ctx.coordinatorIndex === ctx.mySignerIndex &&
    ctx.state === SigningState.ROUND1_COMMITTED
  ) {
    ctx.state = SigningState.ROUND2_SIGNED;
    ctx.timeoutAt = Date.now() + ROUND_TIMEOUT_MS;

    return [
      {
        type: ActionType.INVOKE_FROST,
        command: { op: "aggregate", shares: new Map(ctx.round2Shares) },
      },
    ];
  }
  return [];
}

export function handleSignatureResult(
  ctx: SigningContext,
  rx: bigint,
  ry: bigint,
  z: bigint
): CeremonyAction[] {
  if (ctx.state !== SigningState.ROUND2_SIGNED) return [];

  ctx.state = SigningState.EXECUTING;
  ctx.result = { rx, ry, z };

  // coordinator submits (lowest accepted index)
  if (ctx.coordinatorIndex === ctx.mySignerIndex) {
    return [{ type: ActionType.SUBMIT_TX, signature: { rx, ry, z } }];
  }
  return [];
}

export function handleExecuted(ctx: SigningContext): CeremonyAction[] {
  if (ctx.state !== SigningState.EXECUTING) return [];

  ctx.state = SigningState.COMPLETE;
  if (ctx.result) {
    return [{ type: ActionType.COMPLETE, result: ctx.result }];
  }
  return [];
}

export function checkTimeout(ctx: SigningContext): CeremonyAction[] {
  if (ctx.timeoutAt && Date.now() > ctx.timeoutAt) {
    const prev = ctx.state;
    ctx.state = SigningState.ABORTED;
    return [{ type: ActionType.ABORT, reason: `timeout in ${prev}` }];
  }
  return [];
}
