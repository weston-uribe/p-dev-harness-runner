import { randomUUID } from "node:crypto";
import type {
  VercelBridgeOrchestrationPhase,
  VercelBridgeRedeployVerification,
  VercelBridgeRedeployVerificationStatus,
  VercelBridgeVerificationFailureClass,
  VercelSignedProbeEvidence,
} from "./control-plane-types.js";

export const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 5;
export const VERIFICATION_POLL_INTERVAL_MS = 5_000;
export const VERIFICATION_CLAIM_STALE_MS = 30_000;

const TERMINAL_REDEPLOY_STATUSES = new Set<VercelBridgeRedeployVerificationStatus>([
  "failed",
  "timeout",
  "no_source_deployment",
  "verify_failed",
  "verified",
]);

export function isTerminalRedeployVerificationStatus(
  status: VercelBridgeRedeployVerificationStatus,
): boolean {
  return TERMINAL_REDEPLOY_STATUSES.has(status);
}

export function classifySignedProbeFailure(
  probe?: Pick<VercelSignedProbeEvidence, "result" | "reason">,
): VercelBridgeVerificationFailureClass {
  if (!probe?.result) {
    return "terminal";
  }

  switch (probe.result) {
    case "unreachable":
    case "error":
    case "auth_failed":
      return "retryable";
    case "protection_redirect":
      return "terminal";
    case "accepted_ignored":
      return "terminal";
    default:
      return "terminal";
  }
}

function derivePhaseFromStatus(
  pending: VercelBridgeRedeployVerification,
): VercelBridgeOrchestrationPhase {
  if (pending.phase) {
    return pending.phase;
  }

  switch (pending.status) {
    case "triggered":
      return "triggered";
    case "building":
      return "building";
    case "ready":
      return pending.verificationClaim
        ? "verifying"
        : pending.nextVerificationAttemptAt
          ? "retry_wait"
          : "waiting_for_ready";
    case "verified":
      return "verified";
    case "verify_failed":
    case "failed":
    case "timeout":
    case "no_source_deployment":
      return "terminal";
    default:
      return "waiting_for_ready";
  }
}

export function normalizeRedeployVerification(input: {
  pending: VercelBridgeRedeployVerification;
  signedProbe?: VercelSignedProbeEvidence;
}): VercelBridgeRedeployVerification {
  const maxAttempts =
    input.pending.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;
  let verificationAttemptCount = input.pending.verificationAttemptCount;

  if (verificationAttemptCount === undefined) {
    if (input.pending.verifyAttempted) {
      const failureClass = classifySignedProbeFailure(
        input.signedProbe ?? undefined,
      );
      if (
        input.pending.status === "verify_failed" &&
        failureClass === "retryable" &&
        Date.parse(input.pending.deadlineAt) > Date.now()
      ) {
        verificationAttemptCount = 1;
      } else {
        verificationAttemptCount = maxAttempts;
      }
    } else {
      verificationAttemptCount = 0;
    }
  }

  const normalized: VercelBridgeRedeployVerification = {
    ...input.pending,
    maxVerificationAttempts: maxAttempts,
    verificationAttemptCount,
    phase: derivePhaseFromStatus(input.pending),
  };

  if (
    normalized.verifyAttempted &&
    verificationAttemptCount >= maxAttempts &&
    normalized.status === "verify_failed"
  ) {
    normalized.phase = "terminal";
  }

  return normalized;
}

export function isOrchestrationActive(
  pending?: VercelBridgeRedeployVerification,
): boolean {
  if (!pending) {
    return false;
  }
  return !isTerminalRedeployVerificationStatus(pending.status);
}

export function isVerificationClaimStale(
  pending: VercelBridgeRedeployVerification,
  now = Date.now(),
): boolean {
  const claim = pending.verificationClaim;
  if (!claim?.claimedAt) {
    return true;
  }
  const age = now - Date.parse(claim.claimedAt);
  return Number.isNaN(age) || age > VERIFICATION_CLAIM_STALE_MS;
}

export function isVerificationAttemptDue(
  pending: VercelBridgeRedeployVerification,
  now = Date.now(),
): boolean {
  return getVerificationAttemptNotDueReason(pending, now) === "due";
}

export function getVerificationAttemptNotDueReason(
  pending: VercelBridgeRedeployVerification,
  now = Date.now(),
):
  | "due"
  | "deadline_expired"
  | "budget_exhausted"
  | "waiting_for_schedule"
  | "claim_in_flight"
  | "not_ready" {
  const normalized = normalizeRedeployVerification({ pending });
  const attemptCount = normalized.verificationAttemptCount ?? 0;
  const maxAttempts = normalized.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;

  if (normalized.status !== "ready") {
    return "not_ready";
  }
  if (attemptCount >= maxAttempts) {
    return "budget_exhausted";
  }
  if (Date.parse(normalized.deadlineAt) <= now) {
    return "deadline_expired";
  }
  if (
    normalized.verificationClaim &&
    !isVerificationClaimStale(normalized, now)
  ) {
    return "claim_in_flight";
  }
  if (normalized.nextVerificationAttemptAt) {
    return Date.parse(normalized.nextVerificationAttemptAt) <= now
      ? "due"
      : "waiting_for_schedule";
  }
  return "due";
}

export function buildVerificationClaim(
  attemptNumber: number,
): VercelBridgeRedeployVerification["verificationClaim"] {
  return {
    attemptNumber,
    claimId: randomUUID(),
    claimedAt: new Date().toISOString(),
  };
}

export function getOrchestrationStatusMessage(
  pending: VercelBridgeRedeployVerification,
): string {
  const normalized = normalizeRedeployVerification({ pending });
  const attemptCount = normalized.verificationAttemptCount ?? 0;
  const maxAttempts =
    normalized.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;

  switch (normalized.phase) {
    case "triggered":
      return "Redeploying production so new env vars take effect…";
    case "building":
      return "Waiting for the production deployment…";
    case "waiting_for_ready":
      return "Waiting for the production deployment…";
    case "verifying":
      return "Verifying the signed webhook…";
    case "retry_wait":
      return `Retrying signed webhook verification (attempt ${Math.min(attemptCount + 1, maxAttempts)} of ${maxAttempts})…`;
    case "verified":
      return "Vercel settings verified.";
    case "terminal":
      return (
        normalized.blockedMessage ??
        normalized.message ??
        "Vercel bridge verification requires operator action."
      );
    default:
      return normalized.message ?? "Applying Vercel settings…";
  }
}

export function mapPendingPhaseForDeployStatus(
  status: VercelBridgeRedeployVerificationStatus,
): VercelBridgeOrchestrationPhase {
  switch (status) {
    case "triggered":
      return "triggered";
    case "building":
      return "building";
    case "ready":
      return "waiting_for_ready";
    default:
      return "terminal";
  }
}
