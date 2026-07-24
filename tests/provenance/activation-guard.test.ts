import { describe, expect, it } from "vitest";
import {
  buildExpiredActivationIncompleteEvidence,
  validateActivationGuard,
} from "../../src/provenance/activation-guard.js";

describe("activation guard", () => {
  it("fails closed when commit timestamp is not before activatedAt", () => {
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const result = validateActivationGuard({
      activationCommitTimestamp: activatedAt,
      activatedAt,
      minGuardDurationMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("activation_commit_not_before_effective");
  });

  it("fails when required mode verification misses cutoff", () => {
    const result = validateActivationGuard({
      activationCommitTimestamp: "2026-08-01T11:00:00.000Z",
      activatedAt: "2026-08-01T12:00:00.000Z",
      requiredModeVerifiedAt: "2026-08-01T12:30:00.000Z",
      minGuardDurationMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("required_mode_verified_after_activation");
  });

  it("builds expired activation incomplete evidence", () => {
    const evidence = buildExpiredActivationIncompleteEvidence({
      activatedAt: "2026-08-01T12:00:00.000Z",
      activationCommitTimestamp: "2026-08-01T12:00:00.000Z",
      minGuardDurationMs: 60_000,
      reasons: ["activation_guard_expired"],
    });
    expect(evidence.kind).toBe(
      "p-dev.cursor-cloud-agent-activation-guard-incomplete.v1",
    );
    expect(evidence.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
