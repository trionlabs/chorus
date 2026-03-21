import type { Transaction } from "../ceremony/types.js";

export interface Policy {
  maxValue: bigint;
  allowedTargets: string[];
}

export interface Evaluation {
  approved: boolean;
  reason: string;
}

export function evaluate(tx: Transaction, policy: Policy): Evaluation {
  if (tx.value > policy.maxValue) {
    return { approved: false, reason: `value ${tx.value} exceeds max ${policy.maxValue}` };
  }
  if (!policy.allowedTargets.includes(tx.to.toLowerCase())) {
    return { approved: false, reason: `target ${tx.to} not in allowlist` };
  }
  return { approved: true, reason: "within policy bounds" };
}
