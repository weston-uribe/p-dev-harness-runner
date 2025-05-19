import {
  ACTIVATION_RECORD_SCHEMA_KIND,
  parsePersistedActivationRecord,
} from "./activation-attestation.js";
import {
  ACTIVATION_HISTORY_PROOF_KIND,
  parseActivationHistoryProofRecord,
} from "./activation-history-proof.js";
import {
  ACTIVATION_READINESS_SCHEMA_KIND,
  COVERAGE_GAP_SCHEMA_KIND,
  COVERAGE_SEAL_SCHEMA_KIND,
  COVERAGE_SUPERSESSION_SCHEMA_KIND,
  DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND,
  EPOCH_INVALIDATION_SCHEMA_KIND,
  PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND,
  activationHistoryProofRecordDigest,
  parseActivationReadinessRecord,
  parseCoverageGapRecord,
  parseCoverageSealRecord,
  parseCoverageSupersessionRecord,
  parseDuplicateOperationIncidentRecord,
  parseEpochInvalidationRecord,
  parsePersistedCoverageSnapshotEnvelope,
  persistedActivationRecordDigest,
} from "./coverage-lifecycle-schemas.js";
import {
  CANARY_ATTEMPT_ROOT_SCHEMA_KIND,
  CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND,
  CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND,
  CANARY_STAGE_ROOT_SCHEMA_KIND,
  parseCanaryAttemptRootRecord,
  parseCanaryAttemptTransitionRecord,
  parseCanaryAttemptTransitionV2Record,
  parseCanaryStageRootRecord,
} from "./canary-stage-chain.js";
import {
  RECOVERY_OPERATION_ROOT_SCHEMA_KIND,
  parseRecoveryOperationRootRecord,
  recoveryOperationRootDigest,
} from "./recovery-operation.js";

export type LifecycleRecordCanonicalDigestResult =
  | { ok: true; digest: string; kind: string }
  | {
      ok: false;
      code: "lifecycle_integrity_failure";
      reason: string;
    };

function integrityFailure(reason: string): LifecycleRecordCanonicalDigestResult {
  return { ok: false, code: "lifecycle_integrity_failure", reason };
}

function kindFromParsed(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind : null;
}

export function canonicalDigestFromLifecycleRecordBody(
  body: string,
): LifecycleRecordCanonicalDigestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return integrityFailure(
      error instanceof Error ? `malformed_json: ${error.message}` : "malformed_json",
    );
  }

  const kind = kindFromParsed(parsed);
  if (!kind) {
    return integrityFailure("missing_kind");
  }

  try {
    if (kind === ACTIVATION_RECORD_SCHEMA_KIND) {
      const record = parsePersistedActivationRecord(parsed as object);
      return { ok: true, kind, digest: persistedActivationRecordDigest(record) };
    }

    if (kind === ACTIVATION_HISTORY_PROOF_KIND) {
      const record = parseActivationHistoryProofRecord(parsed as object);
      return { ok: true, kind, digest: activationHistoryProofRecordDigest(record) };
    }

    if (kind === PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND) {
      const record = parsePersistedCoverageSnapshotEnvelope(parsed as object);
      return { ok: true, kind, digest: record.envelopeDigest };
    }

    if (kind === COVERAGE_SEAL_SCHEMA_KIND) {
      const record = parseCoverageSealRecord(parsed as object);
      return { ok: true, kind, digest: record.sealDigest };
    }

    if (kind === COVERAGE_GAP_SCHEMA_KIND) {
      const record = parseCoverageGapRecord(parsed as object);
      return { ok: true, kind, digest: record.gapDigest };
    }

    if (kind === COVERAGE_SUPERSESSION_SCHEMA_KIND) {
      const record = parseCoverageSupersessionRecord(parsed as object);
      return { ok: true, kind, digest: record.supersessionDigest };
    }

    if (kind === EPOCH_INVALIDATION_SCHEMA_KIND) {
      const record = parseEpochInvalidationRecord(parsed as object);
      return { ok: true, kind, digest: record.invalidationDigest };
    }

    if (kind === DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND) {
      const record = parseDuplicateOperationIncidentRecord(parsed as object);
      return { ok: true, kind, digest: record.incidentDigest };
    }

    if (kind === RECOVERY_OPERATION_ROOT_SCHEMA_KIND) {
      const record = parseRecoveryOperationRootRecord(parsed as object);
      return { ok: true, kind, digest: recoveryOperationRootDigest(record) };
    }

    if (kind === CANARY_STAGE_ROOT_SCHEMA_KIND) {
      const record = parseCanaryStageRootRecord(parsed as object);
      return { ok: true, kind, digest: record.stageRootDigest };
    }

    if (kind === CANARY_ATTEMPT_ROOT_SCHEMA_KIND) {
      const record = parseCanaryAttemptRootRecord(parsed as object);
      return { ok: true, kind, digest: record.attemptRootDigest };
    }

    if (kind === CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND) {
      const record = parseCanaryAttemptTransitionRecord(parsed as object);
      return { ok: true, kind, digest: record.transitionDigest };
    }

    if (kind === CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND) {
      const record = parseCanaryAttemptTransitionV2Record(parsed as object);
      return { ok: true, kind, digest: record.transitionDigest };
    }

    if (kind === ACTIVATION_READINESS_SCHEMA_KIND) {
      const record = parseActivationReadinessRecord(parsed as object);
      return { ok: true, kind, digest: record.readinessDigest };
    }
  } catch (error) {
    return integrityFailure(
      error instanceof Error ? error.message : "lifecycle_record_integrity_error",
    );
  }

  return integrityFailure(`unknown_kind: ${kind}`);
}

