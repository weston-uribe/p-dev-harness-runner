import { describe, expect, it } from "vitest";
import {
  classifySignedProbeFailure,
  DEFAULT_MAX_VERIFICATION_ATTEMPTS,
  getOrchestrationStatusMessage,
  getVerificationAttemptNotDueReason,
  isVerificationAttemptDue,
  normalizeRedeployVerification,
} from "../../src/setup/vercel-bridge-redeploy-normalize.js";

const basePending = {
  actionId: "vercel-redeploy-test",
  projectId: "proj-1",
  projectName: "harness-gui",
  webhookUrl: "https://example.com/api/linear-webhook",
  fingerprint: "fp-1",
  status: "ready" as const,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() + 300_000).toISOString(),
};

describe("vercel-bridge-redeploy-normalize", () => {
  it("maps legacy verifyAttempted false to zero attempts", () => {
    const normalized = normalizeRedeployVerification({
      pending: { ...basePending, verifyAttempted: false },
    });
    expect(normalized.verificationAttemptCount).toBe(0);
  });

  it("treats legacy verifyAttempted true with retryable evidence as one attempt", () => {
    const normalized = normalizeRedeployVerification({
      pending: {
        ...basePending,
        status: "verify_failed",
        verifyAttempted: true,
      },
      signedProbe: {
        passed: false,
        result: "auth_failed",
        probedAt: new Date().toISOString(),
      },
    });
    expect(normalized.verificationAttemptCount).toBe(1);
  });

  it("treats legacy verifyAttempted true with missing evidence as exhausted", () => {
    const normalized = normalizeRedeployVerification({
      pending: {
        ...basePending,
        status: "verify_failed",
        verifyAttempted: true,
      },
    });
    expect(normalized.verificationAttemptCount).toBe(
      DEFAULT_MAX_VERIFICATION_ATTEMPTS,
    );
  });

  it("classifies propagation failures as retryable", () => {
    expect(
      classifySignedProbeFailure({ result: "auth_failed", reason: "invalid" }),
    ).toBe("retryable");
    expect(classifySignedProbeFailure({ result: "protection_redirect" })).toBe(
      "terminal",
    );
  });

  it("returns retry status copy for retry_wait phase", () => {
    const message = getOrchestrationStatusMessage({
      ...basePending,
      phase: "retry_wait",
      verificationAttemptCount: 2,
      maxVerificationAttempts: 5,
    });
    expect(message).toMatch(/attempt 3 of 5/i);
  });

  it("does not schedule attempts before nextVerificationAttemptAt", () => {
    const due = isVerificationAttemptDue({
      ...basePending,
      verificationAttemptCount: 1,
      maxVerificationAttempts: 5,
      nextVerificationAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(due).toBe(false);
  });

  it("reports deadline_expired when verification window ends", () => {
    expect(
      getVerificationAttemptNotDueReason({
        ...basePending,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).toBe("deadline_expired");
  });

  it("allows the first verification attempt immediately at READY", () => {
    expect(
      getVerificationAttemptNotDueReason({
        ...basePending,
        verificationAttemptCount: 0,
      }),
    ).toBe("due");
  });
});
