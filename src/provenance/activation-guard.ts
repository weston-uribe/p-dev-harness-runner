/**
 * Future-effective activation guard: fail closed when operator attestations expire.
 */

import { createHash } from "node:crypto";

export const ACTIVATION_GUARD_INCOMPLETE_EVIDENCE_KIND =
  "p-dev.cursor-cloud-agent-activation-guard-incomplete.v1" as const;

export interface ActivationGuardValidationInput {
  activationCommitTimestamp: string;
  activatedAt: string;
  requiredModeVerifiedAt?: string | null;
  isolationCheckCompletedAt?: string | null;
  minGuardDurationMs: number;
}

export interface ActivationGuardValidationResult {
  ok: boolean;
  expired: boolean;
  reasons: string[];
}

export interface ExpiredActivationIncompleteEvidence {
  kind: typeof ACTIVATION_GUARD_INCOMPLETE_EVIDENCE_KIND;
  version: "1";
  activatedAt: string;
  activationCommitTimestamp: string;
  requiredModeVerifiedAt: string | null;
  isolationCheckCompletedAt: string | null;
  minGuardDurationMs: number;
  expiredAt: string;
  reasons: string[];
  evidenceDigest: string;
}

function parseIso(value: string): number {
  return Date.parse(value);
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(parseIso(value))) {
    throw new Error(`${label} must be a valid UTC ISO timestamp`);
  }
}

export function validateActivationGuard(
  input: ActivationGuardValidationInput,
): ActivationGuardValidationResult {
  assertTimestamp(input.activationCommitTimestamp, "activationCommitTimestamp");
  assertTimestamp(input.activatedAt, "activatedAt");
  if (input.minGuardDurationMs < 0) {
    throw new Error("minGuardDurationMs must be >= 0");
  }

  const reasons: string[] = [];
  const commitMs = parseIso(input.activationCommitTimestamp);
  const activatedMs = parseIso(input.activatedAt);

  if (commitMs >= activatedMs) {
    reasons.push("activation_commit_not_before_effective");
  }

  if (input.requiredModeVerifiedAt) {
    assertTimestamp(input.requiredModeVerifiedAt, "requiredModeVerifiedAt");
    if (parseIso(input.requiredModeVerifiedAt) > activatedMs) {
      reasons.push("required_mode_verified_after_activation");
    }
  }

  if (input.isolationCheckCompletedAt) {
    assertTimestamp(
      input.isolationCheckCompletedAt,
      "isolationCheckCompletedAt",
    );
    if (parseIso(input.isolationCheckCompletedAt) > activatedMs) {
      reasons.push("isolation_check_crosses_activation");
    }
  }

  const guardExpiryMs = activatedMs - input.minGuardDurationMs;
  const nowMs = Date.now();
  if (nowMs >= guardExpiryMs) {
    reasons.push("activation_guard_expired");
  }

  return {
    ok: reasons.length === 0,
    expired: reasons.includes("activation_guard_expired"),
    reasons: [...reasons].sort(),
  };
}

export function buildExpiredActivationIncompleteEvidence(input: {
  activatedAt: string;
  activationCommitTimestamp: string;
  requiredModeVerifiedAt?: string | null;
  isolationCheckCompletedAt?: string | null;
  minGuardDurationMs: number;
  expiredAt?: string;
  reasons: string[];
}): ExpiredActivationIncompleteEvidence {
  const expiredAt = input.expiredAt ?? new Date().toISOString();
  const partial = {
    kind: ACTIVATION_GUARD_INCOMPLETE_EVIDENCE_KIND,
    version: "1" as const,
    activatedAt: input.activatedAt,
    activationCommitTimestamp: input.activationCommitTimestamp,
    requiredModeVerifiedAt: input.requiredModeVerifiedAt ?? null,
    isolationCheckCompletedAt: input.isolationCheckCompletedAt ?? null,
    minGuardDurationMs: input.minGuardDurationMs,
    expiredAt,
    reasons: [...input.reasons].sort(),
  };
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify(partial), "utf8")
    .digest("hex");
  return { ...partial, evidenceDigest };
}

export function activationGuardExpiredAt(
  activatedAt: string,
  minGuardDurationMs: number,
): string {
  return new Date(parseIso(activatedAt) - minGuardDurationMs).toISOString();
}
