import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINALIZATION_POLICY,
  finalizePolicyDigest,
  pinFinalizationPolicy,
} from "../../src/provenance/finalization-policy.js";
import { buildCoverageSealRecord } from "../../src/provenance/coverage-lifecycle-schemas.js";

describe("finalization policy", () => {
  it("produces stable digest for default policy", () => {
    const a = finalizePolicyDigest(DEFAULT_FINALIZATION_POLICY);
    const b = finalizePolicyDigest(DEFAULT_FINALIZATION_POLICY);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins digest into seal record when provided", () => {
    const pin = pinFinalizationPolicy();
    const seal = buildCoverageSealRecord({
      epochId: "epoch-1",
      interval: {
        coverageStart: "2026-07-10T00:00:00.000Z",
        coverageEnd: "2026-07-20T00:00:00.000Z",
      },
      coverageDigest: "a".repeat(64),
      activationCommitSha: "b".repeat(40),
      eventSnapshotCommitSha: "c".repeat(40),
      activationHistoryProofCommitSha: "d".repeat(40),
      activationHistoryProofDigest: "e".repeat(64),
      coverageSnapshotCommitSha: "f".repeat(40),
      coverageSnapshotDigest: "1".repeat(64),
      finalizationEvidenceDigest: "2".repeat(64),
      operatorToolSourceSha: "3".repeat(40),
      finalizationPolicyDigest: pin.digest,
    });
    expect(seal.finalizationPolicyDigest).toBe(pin.digest);
  });
});
