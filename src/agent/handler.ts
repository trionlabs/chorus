import {
  ActionType,
  type CeremonyAction,
  type SigningContext,
} from "../ceremony/types.js";
import {
  handleAccept,
  handleReject,
  handleRound1,
  handleSigningPackage,
  handleRound2,
  handleSignatureResult,
  handleExecuted,
} from "../ceremony/signing.js";
import {
  createCeremonyDir,
  cleanup,
  commitRound1,
  writeCommitments,
  prepareSigning,
  writeSigningPackage,
  signRound2,
  writeSignatureShare,
  aggregate,
  type CeremonyDir,
} from "../frost/executor.js";
import type { ProtocolMessage } from "../xmtp/messages.js";

export interface AgentConfig {
  name: string;
  shareIndex: number;
  keysDir: string;
  threshold: number;
  totalSigners: number;
}

export interface CeremonyRuntime {
  ceremonyDir: CeremonyDir | null;
  receivedCommitments: Map<number, string>;
  receivedSigningPackage: string | null;
  receivedShares: Map<number, string>;
}

export function createRuntime(): CeremonyRuntime {
  return {
    ceremonyDir: null,
    receivedCommitments: new Map(),
    receivedSigningPackage: null,
    receivedShares: new Map(),
  };
}

export function extractPeerData(
  runtime: CeremonyRuntime,
  msg: ProtocolMessage
): void {
  if (msg.type === "frost/round1") {
    runtime.receivedCommitments.set(msg.signerIndex, msg.commitments);
  }
  if (msg.type === "frost/signing-package") {
    runtime.receivedSigningPackage = msg.signingPackage;
  }
  if (msg.type === "frost/round2") {
    runtime.receivedShares.set(msg.signerIndex, msg.signatureShare);
  }
}

export function routeMessage(
  ctx: SigningContext,
  msg: ProtocolMessage
): CeremonyAction[] {
  switch (msg.type) {
    case "frost/accept":
      return handleAccept(ctx, msg.signerIndex);
    case "frost/reject":
      return handleReject(ctx, msg.signerIndex, msg.reason);
    case "frost/round1":
      return handleRound1(ctx, msg.signerIndex, msg.commitments);
    case "frost/signing-package":
      return handleSigningPackage(ctx, msg.participantIndices);
    case "frost/round2":
      return handleRound2(ctx, msg.signerIndex, msg.signatureShare);
    case "frost/signature":
      return handleSignatureResult(
        ctx,
        BigInt(msg.rx),
        BigInt(msg.ry),
        BigInt(msg.z)
      );
    case "frost/executed":
      return handleExecuted(ctx);
    default:
      return [];
  }
}

export async function executeActions(
  actions: CeremonyAction[],
  ctx: SigningContext,
  runtime: CeremonyRuntime,
  config: AgentConfig,
  reply: (msg: ProtocolMessage) => Promise<void>
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case ActionType.INVOKE_FROST: {
        const cmd = action.command;
        switch (cmd.op) {
          case "commit": {
            if (!runtime.ceremonyDir) {
              runtime.ceremonyDir = createCeremonyDir(
                config.keysDir,
                config.shareIndex
              );
            }
            const hex = commitRound1(runtime.ceremonyDir);
            runtime.receivedCommitments.set(config.shareIndex, hex);
            await reply({
              type: "frost/round1",
              proposalId: ctx.proposalId,
              signerIndex: config.shareIndex,
              commitments: hex,
            });
            break;
          }

          case "prepare": {
            for (const [idx, hex] of runtime.receivedCommitments) {
              if (idx !== config.shareIndex) {
                writeCommitments(runtime.ceremonyDir!, idx, hex);
              }
            }
            const pkg = prepareSigning(runtime.ceremonyDir!, cmd.message);
            runtime.receivedSigningPackage = pkg;
            await reply({
              type: "frost/signing-package",
              proposalId: ctx.proposalId,
              coordinatorIndex: config.shareIndex,
              signingPackage: pkg,
              participantIndices: [...runtime.receivedCommitments.keys()],
            });
            break;
          }

          case "sign": {
            if (
              ctx.coordinatorIndex !== config.shareIndex &&
              runtime.receivedSigningPackage
            ) {
              writeSigningPackage(
                runtime.ceremonyDir!,
                runtime.receivedSigningPackage
              );
            }
            const share = signRound2(runtime.ceremonyDir!);
            runtime.receivedShares.set(config.shareIndex, share);
            await reply({
              type: "frost/round2",
              proposalId: ctx.proposalId,
              signerIndex: config.shareIndex,
              signatureShare: share,
            });
            break;
          }

          case "aggregate": {
            for (const [idx, hex] of runtime.receivedShares) {
              if (idx !== config.shareIndex) {
                writeSignatureShare(runtime.ceremonyDir!, idx, hex);
              }
            }
            const result = aggregate(runtime.ceremonyDir!);
            await reply({
              type: "frost/signature",
              proposalId: ctx.proposalId,
              coordinatorIndex: config.shareIndex,
              rx: result.rx.toString(),
              ry: result.ry.toString(),
              z: result.z.toString(),
            });
            break;
          }
        }
        break;
      }

      case ActionType.COMPLETE: {
        console.log(`[${config.name}] ceremony complete: ${ctx.proposalId}`);
        cleanupRuntime(runtime);
        break;
      }

      case ActionType.ABORT: {
        console.error(`[${config.name}] ceremony aborted: ${action.reason}`);
        cleanupRuntime(runtime);
        break;
      }

      case ActionType.SUBMIT_TX: {
        console.log(
          `[${config.name}] submit tx with sig rx=${action.signature.rx}`
        );
        break;
      }
    }
  }
}

export function cleanupRuntime(runtime: CeremonyRuntime): void {
  if (runtime.ceremonyDir) {
    cleanup(runtime.ceremonyDir);
    runtime.ceremonyDir = null;
  }
  runtime.receivedCommitments.clear();
  runtime.receivedSigningPackage = null;
  runtime.receivedShares.clear();
}
