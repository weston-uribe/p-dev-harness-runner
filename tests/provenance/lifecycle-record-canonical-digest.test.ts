import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPersistedActivationRecord,
  type CanonicalActivationPayload,
} from "../../src/provenance/activation-attestation.js";
import { ACTIVATION_HISTORY_PROOF_KIND } from "../../src/provenance/activation-history-proof.js";
import {
  buildActivationHistoryProofRecord,
  buildActivationReadinessRecord,
  buildCoverageGapRecord,
  buildCoverageSealRecord,
  buildCoverageSupersessionRecord,
  buildDuplicateOperationIncidentRecord,
  buildEpochInvalidationRecord,
  buildPersistedCoverageSnapshotEnvelope,
  persistedActivationRecordDigest,
  activationHistoryProofRecordDigest,
} from "../../src/provenance/coverage-lifecycle-schemas.js";
import { buildLiveActivationPayload } from "../../src/provenance/live-activation.js";
import { canonicalDigestFromLifecycleRecordBody } from "../../src/provenance/lifecycle-record-canonical-digest.js";
import { compareExistingLifecycleRecord } from "../../src/provenance/lifecycle-store.js";
import {
  buildRecoveryOperationRootRecord,
  recoveryOperationRootDigest,
} from "../../src/provenance/recovery-operation.js";
import {
  buildCanaryAttemptRootRecord,
  buildCanaryAttemptTransitionRecord,
  buildCanaryAttemptTransitionV2Record,
  buildCanaryStageRootRecord,
} from "../../src/provenance/canary-stage-chain.js";
import { COVERAGE_SCHEMA_KIND } from "../../src/provenance/coverage.js";

function bodyOf(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("canonicalDigestFromLifecycleRecordBody", () => {
  it("returns integrity failure for malformed, missing kind, unknown kind", () => {
    expect(canonicalDigestFromLifecycleRecordBody("{")).toEqual(
      expect.objectContaining({ ok: false, code: "lifecycle_integrity_failure" }),
    );
    expect(canonicalDigestFromLifecycleRecordBody("{}")).toEqual(
      expect.objectContaining({
        ok: false,
        code: "lifecycle_integrity_failure",
        reason: "missing_kind",
      }),
    );
    expect(
      canonicalDigestFromLifecycleRecordBody(bodyOf({ kind: "nope", version: "1" })),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "lifecycle_integrity_failure",
        reason: expect.stringContaining("unknown_kind"),
      }),
    );
  });

  it("canonicalizes activation record digest (recomputed)", () => {
    const payload: CanonicalActivationPayload = buildLiveActivationPayload({
      epochId: "epoch-test",
      activatedAt: "2026-07-20T00:00:00.000Z",
      interval: {
        coverageStart: "2026-07-20T00:00:00.000Z",
        coverageEnd: "2026-07-20T01:00:00.000Z",
      },
      captureProducerSourceSha: "c".repeat(40),
      productionRunnerSha: "r".repeat(40),
    });
    const record = buildPersistedActivationRecord(payload);
    const result = canonicalDigestFromLifecycleRecordBody(bodyOf(record));
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        digest: persistedActivationRecordDigest(record),
      }),
    );
  });

  it("canonicalizes activation history proof digest (NOT evidenceDigest)", () => {
    const record = buildActivationHistoryProofRecord({
      stateRepository: "weston-uribe/p-dev-harness-state",
      stateBranch: "main",
      activationCommitSha: "a".repeat(40),
      eventSnapshotCommitSha: "b".repeat(40),
      claimedRelationship: "descendant",
    });
    const result = canonicalDigestFromLifecycleRecordBody(bodyOf(record));
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        kind: ACTIVATION_HISTORY_PROOF_KIND,
        digest: activationHistoryProofRecordDigest(record),
      }),
    );
    expect(record.evidenceDigest).toBeTruthy();
    expect(record.evidenceDigest).not.toBe(activationHistoryProofRecordDigest(record));
  });

  it("repair-1 history proof: evidenceDigest ≠ recordDigest; identical adopt uses recordDigest", () => {
    // Byte-identical to live-rollout-2026-07-24-required-repair-1 history proof
    // at commit d7bc6e088bb31ead4b273bb358e93272e3fa4b8e.
    const repair1Proof = {
      kind: ACTIVATION_HISTORY_PROOF_KIND,
      version: "1" as const,
      stateRepository: "weston-uribe/p-dev-harness-state",
      stateBranch: "p-dev-runtime-state",
      activationCommitSha: "844809a95a70a4f8cb1033f21b3cf6cb234e22ec",
      eventSnapshotCommitSha: "1d913479d460bd675a0f9a3e2115f5308bae053e",
      claimedRelationship: "descendant" as const,
      evidenceDigest:
        "c9f6123bd565d1c2e5d125579da82253ebf31c578e11363f49637c45935e1070",
    };
    const expectedRecordDigest =
      "5b3840615782f3d366bae29f1eee5cbefc5610759f1082a4747a176d87cff164";
    expect(repair1Proof.evidenceDigest).toBe(
      "c9f6123bd565d1c2e5d125579da82253ebf31c578e11363f49637c45935e1070",
    );
    expect(activationHistoryProofRecordDigest(repair1Proof)).toBe(
      expectedRecordDigest,
    );
    expect(repair1Proof.evidenceDigest).not.toBe(expectedRecordDigest);

    const result = canonicalDigestFromLifecycleRecordBody(bodyOf(repair1Proof));
    expect(result).toEqual({
      ok: true,
      kind: ACTIVATION_HISTORY_PROOF_KIND,
      digest: expectedRecordDigest,
    });

    // Identical replay must compare against recordDigest, not evidenceDigest.
    expect(
      compareExistingLifecycleRecord(bodyOf(repair1Proof), expectedRecordDigest),
    ).toBe("identical");
    expect(
      compareExistingLifecycleRecord(
        bodyOf(repair1Proof),
        repair1Proof.evidenceDigest,
      ),
    ).toBe("divergent");
  });

  it("treats proofs with same evidenceDigest but different claimedRelationship as divergent", () => {
    const base = buildActivationHistoryProofRecord({
      stateRepository: "weston-uribe/p-dev-harness-state",
      stateBranch: "main",
      activationCommitSha: "a".repeat(40),
      eventSnapshotCommitSha: "b".repeat(40),
      claimedRelationship: "descendant",
    });
    const sameEvidenceDifferentClaim = {
      ...base,
      claimedRelationship: "unverified" as const,
    };

    const a = canonicalDigestFromLifecycleRecordBody(bodyOf(base));
    const b = canonicalDigestFromLifecycleRecordBody(bodyOf(sameEvidenceDifferentClaim));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(base.evidenceDigest).toBe(sameEvidenceDifferentClaim.evidenceDigest);
    if (a.ok && b.ok) {
      expect(a.digest).not.toBe(b.digest);
    }
  });

  it("canonicalizes coverage envelope/seal/gap/supersession/invalidation/incident", () => {
    const interval = {
      coverageStart: "2026-07-20T00:00:00.000Z",
      coverageEnd: "2026-07-20T01:00:00.000Z",
    };

    const envelope = buildPersistedCoverageSnapshotEnvelope({
      epochId: "epoch-test",
      activationCommitSha: "a".repeat(40),
      eventSnapshotCommitSha: "b".repeat(40),
      activationHistoryProofCommitSha: "c".repeat(40),
      activationHistoryProofDigest: "d".repeat(64),
      snapshot: { kind: COVERAGE_SCHEMA_KIND, version: "1" } as unknown as any,
    });
    const envelopeResult = canonicalDigestFromLifecycleRecordBody(bodyOf(envelope));
    expect(envelopeResult).toEqual(
      expect.objectContaining({ ok: true, digest: envelope.envelopeDigest }),
    );

    const seal = buildCoverageSealRecord({
      epochId: "epoch-test",
      interval,
      coverageDigest: "c".repeat(64),
      activationCommitSha: "a".repeat(40),
      eventSnapshotCommitSha: "b".repeat(40),
      activationHistoryProofCommitSha: "c".repeat(40),
      activationHistoryProofDigest: "d".repeat(64),
      coverageSnapshotCommitSha: "e".repeat(40),
      coverageSnapshotDigest: envelope.envelopeDigest,
      finalizationEvidenceDigest: "f".repeat(64),
      operatorToolSourceSha: "o".repeat(40),
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(seal))).toEqual(
      expect.objectContaining({ ok: true, digest: seal.sealDigest }),
    );

    const gap = buildCoverageGapRecord({
      epochId: "epoch-test",
      intervalAttempted: interval,
      incompleteReasons: ["coverage_event_snapshot_missing"] as any,
      evidenceDigest: "e".repeat(64),
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(gap))).toEqual(
      expect.objectContaining({ ok: true, digest: gap.gapDigest }),
    );

    const supersession = buildCoverageSupersessionRecord({
      priorSealCommitSha: "s".repeat(40),
      priorSealDigest: seal.sealDigest,
      reason: "test",
      overlappingEvidenceDigest: "e".repeat(64),
      newEpochId: null,
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(supersession))).toEqual(
      expect.objectContaining({ ok: true, digest: supersession.supersessionDigest }),
    );

    const invalidation = buildEpochInvalidationRecord({
      epochId: "epoch-test",
      activationCommitSha: "a".repeat(40),
      invalidInterval: interval,
      reasons: ["test"],
      eventCommitRange: {
        startCommitSha: "a".repeat(40),
        endCommitSha: "b".repeat(40),
      },
      operatorToolSourceSha: "o".repeat(40),
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(invalidation))).toEqual(
      expect.objectContaining({
        ok: true,
        digest: invalidation.invalidationDigest,
      }),
    );

    const incident = buildDuplicateOperationIncidentRecord({
      epochId: "epoch-test",
      recoveryOperationId: randomUUID(),
      stage: "required_canary",
      attemptOrdinal: 1,
      duplicateOperationId: randomUUID(),
      priorOperationId: randomUUID(),
      recordedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(incident))).toEqual(
      expect.objectContaining({
        ok: true,
        digest: incident.incidentDigest,
      }),
    );
  });

  it("canonicalizes recovery/canary root records", () => {
    const recoveryRoot = buildRecoveryOperationRootRecord({
      priorEpochId: "epoch-prior",
      recoveryOperationId: randomUUID(),
      newEpochId: "epoch-new",
      plannedStage: "required_canary",
      activationScheduleIdentity: "schedule-v1",
      creatorSessionId: "creator",
      contractVersion: "1",
    });
    const recoveryResult = canonicalDigestFromLifecycleRecordBody(bodyOf(recoveryRoot));
    expect(recoveryResult).toEqual(
      expect.objectContaining({
        ok: true,
        digest: recoveryOperationRootDigest(recoveryRoot),
      }),
    );

    const stageRoot = buildCanaryStageRootRecord({
      recoveryOperationId: randomUUID(),
      epochId: "epoch-test",
      stage: "required_canary",
      contractVersion: "1",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(stageRoot))).toEqual(
      expect.objectContaining({ ok: true, digest: stageRoot.stageRootDigest }),
    );

    const attemptRoot = buildCanaryAttemptRootRecord({
      recoveryOperationId: stageRoot.recoveryOperationId,
      epochId: "epoch-test",
      stage: "required_canary",
      ordinal: 1,
      operationId: randomUUID(),
      contractVersion: "1",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(attemptRoot))).toEqual(
      expect.objectContaining({ ok: true, digest: attemptRoot.attemptRootDigest }),
    );

    const transition = buildCanaryAttemptTransitionRecord({
      recoveryOperationId: stageRoot.recoveryOperationId,
      epochId: "epoch-test",
      stage: "required_canary",
      ordinal: 1,
      transitionId: "transition-1",
      transitionKind: "issue_create_intent",
      recordedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(transition))).toEqual(
      expect.objectContaining({ ok: true, digest: transition.transitionDigest }),
    );

    const transitionV2 = buildCanaryAttemptTransitionV2Record({
      recoveryOperationId: stageRoot.recoveryOperationId,
      epochId: "epoch-test",
      stage: "required_canary",
      ordinal: 1,
      transitionId: "transition-v2-1",
      transitionKind: "issue_create_intent",
      previousTransitionId: null,
      previousTransitionDigest: null,
      recordedAt: "2026-07-20T00:00:00.000Z",
      publicSafePayload: { hello: "world" },
      contractVersion: "2",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(transitionV2))).toEqual(
      expect.objectContaining({ ok: true, digest: transitionV2.transitionDigest }),
    );
  });

  it("canonicalizes activation readiness record digest", () => {
    const readiness = buildActivationReadinessRecord({
      epochId: "epoch-test",
      activationCommitSha: "a".repeat(40),
      activatedAt: "2026-08-01T12:00:00.000Z",
      cutoff: "2026-08-01T11:00:00.000Z",
      verifiedMode: "required",
      modeVerifiedAt: "2026-08-01T10:00:00.000Z",
      isolationEvidenceDigest: "b".repeat(64),
      verificationObservedAt: "2026-08-01T10:05:00.000Z",
      contractVersion: "1",
    });
    expect(canonicalDigestFromLifecycleRecordBody(bodyOf(readiness))).toEqual(
      expect.objectContaining({ ok: true, digest: readiness.readinessDigest }),
    );
  });

  it("fails integrity on unsupported canary stage root version", () => {
    const stageRoot = buildCanaryStageRootRecord({
      recoveryOperationId: randomUUID(),
      epochId: "epoch-test",
      stage: "required_canary",
      contractVersion: "1",
    });
    const tampered = { ...stageRoot, version: "2" as const };
    const result = canonicalDigestFromLifecycleRecordBody(bodyOf(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid canary stage root record");
    }
  });

  it("ensures kind must be the coverage schema kind for snapshot envelopes", () => {
    const envelope = buildPersistedCoverageSnapshotEnvelope({
      epochId: "epoch-test",
      activationCommitSha: "a".repeat(40),
      eventSnapshotCommitSha: "b".repeat(40),
      activationHistoryProofCommitSha: "c".repeat(40),
      activationHistoryProofDigest: "d".repeat(64),
      snapshot: { kind: COVERAGE_SCHEMA_KIND, version: "1" } as unknown as any,
    });
    const tampered = {
      ...envelope,
      snapshot: { ...(envelope.snapshot as any), kind: "not-coverage" },
    };
    const result = canonicalDigestFromLifecycleRecordBody(bodyOf(tampered));
    expect(result.ok).toBe(false);
  });
});

