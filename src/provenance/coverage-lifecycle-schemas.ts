import { createHash } from "node:crypto";
import {
  ACTIVATION_HISTORY_PROOF_KIND,
  computeHistoryProofEvidenceDigest,
  type ActivationHistoryProofRecord,
} from "./activation-history-proof.js";
import {
  ACTIVATION_RECORD_SCHEMA_KIND,
  activationPayloadDigest,
  type CanonicalActivationPayload,
  type PersistedActivationRecord,
} from "./activation-attestation.js";
import {
  COVERAGE_SCHEMA_KIND,
  type CoverageInterval,
  type CoverageSnapshot,
} from "./coverage.js";
import type { CoverageIncompleteReason } from "./event-integrity.js";

export const COVERAGE_SEAL_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-seal.v1" as const;

export const COVERAGE_GAP_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-gap.v1" as const;

export const COVERAGE_SUPERSESSION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-supersession.v1" as const;

export const PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND =
  "p-dev.cursor-cloud-agent-registry-coverage-persisted.v1" as const;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid UTC ISO timestamp`);
  }
}

function assertSha256Digest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 64-char hex digest`);
  }
}

function assertCommitSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a git commit SHA`);
  }
}

export const EPOCH_INVALIDATION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-epoch-invalidation.v1" as const;

export const DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-duplicate-operation-incident.v1" as const;

export const ACTIVATION_READINESS_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-activation-readiness.v1" as const;

export interface ImproperPriorSealPin {
  sealCommitSha: string;
  sealDigest: string;
  treatedAsValidCompleteSeal: false;
}

export interface EpochInvalidationRecord {
  kind: typeof EPOCH_INVALIDATION_SCHEMA_KIND;
  version: "1";
  epochId: string;
  activationCommitSha: string;
  invalidInterval: CoverageInterval;
  reasons: string[];
  publicCanaryIdentities: string[];
  workflowRunIds: string[];
  eventCommitRange: {
    startCommitSha: string;
    endCommitSha: string;
  };
  gapId: string | null;
  incidentId: string | null;
  operatorToolSourceSha: string;
  improperPriorSeal?: ImproperPriorSealPin;
  invalidationDigest: string;
}

export interface DuplicateOperationIncidentRecord {
  kind: typeof DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND;
  version: "1";
  epochId: string;
  recoveryOperationId: string;
  stage: string;
  attemptOrdinal: number;
  duplicateOperationId: string;
  priorOperationId: string;
  recordedAt: string;
  incidentDigest: string;
}

export interface ActivationReadinessRecord {
  kind: typeof ACTIVATION_READINESS_SCHEMA_KIND;
  version: "1";
  epochId: string;
  activationCommitSha: string;
  activatedAt: string;
  cutoff: string;
  verifiedMode: "required";
  modeVerifiedAt: string;
  isolationEvidenceDigest: string;
  verificationObservedAt: string;
  contractVersion: string;
  readinessDigest: string;
}

export function activationReadinessRecordDigest(
  record: Omit<ActivationReadinessRecord, "readinessDigest">,
): string {
  return createHash("sha256")
    .update(stableStringify(record), "utf8")
    .digest("hex");
}

export function buildActivationReadinessRecord(input: {
  epochId: string;
  activationCommitSha: string;
  activatedAt: string;
  cutoff: string;
  verifiedMode: "required";
  modeVerifiedAt: string;
  isolationEvidenceDigest: string;
  verificationObservedAt: string;
  contractVersion?: string;
}): ActivationReadinessRecord {
  assertCommitSha(input.activationCommitSha, "activationCommitSha");
  assertTimestamp(input.activatedAt, "activatedAt");
  assertTimestamp(input.cutoff, "cutoff");
  assertTimestamp(input.modeVerifiedAt, "modeVerifiedAt");
  assertTimestamp(input.verificationObservedAt, "verificationObservedAt");
  assertSha256Digest(input.isolationEvidenceDigest, "isolationEvidenceDigest");

  const partial: Omit<ActivationReadinessRecord, "readinessDigest"> = {
    kind: ACTIVATION_READINESS_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    activationCommitSha: input.activationCommitSha,
    activatedAt: input.activatedAt,
    cutoff: input.cutoff,
    verifiedMode: input.verifiedMode,
    modeVerifiedAt: input.modeVerifiedAt,
    isolationEvidenceDigest: input.isolationEvidenceDigest,
    verificationObservedAt: input.verificationObservedAt,
    contractVersion: input.contractVersion ?? "1",
  };
  const readinessDigest = activationReadinessRecordDigest(partial);
  return { ...partial, readinessDigest };
}

export function parseActivationReadinessRecord(
  bytes: string | object,
): ActivationReadinessRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as ActivationReadinessRecord;
  if (parsed.kind !== ACTIVATION_READINESS_SCHEMA_KIND || parsed.version !== "1") {
    throw new Error("invalid activation readiness record");
  }
  const recomputed = buildActivationReadinessRecord(parsed);
  if (recomputed.readinessDigest !== parsed.readinessDigest) {
    throw new Error("activation readiness digest mismatch");
  }
  return parsed;
}

export interface PersistedCoverageSnapshotEnvelope {
  kind: typeof PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND;
  version: "1";
  epochId: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  activationHistoryProofCommitSha: string;
  activationHistoryProofDigest: string;
  snapshot: CoverageSnapshot;
  envelopeDigest: string;
  finalizationPolicyDigest?: string;
}

export interface CoverageSealRecord {
  kind: typeof COVERAGE_SEAL_SCHEMA_KIND;
  version: "1";
  epochId: string;
  interval: CoverageInterval;
  coverageDigest: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  activationHistoryProofCommitSha: string;
  activationHistoryProofDigest: string;
  coverageSnapshotCommitSha: string;
  coverageSnapshotDigest: string;
  finalizationEvidenceDigest: string;
  operatorToolSourceSha: string;
  finalizationPolicyDigest?: string;
  sealDigest: string;
}

export interface CoverageGapRecord {
  kind: typeof COVERAGE_GAP_SCHEMA_KIND;
  version: "1";
  epochId: string;
  intervalAttempted: CoverageInterval;
  incompleteReasons: CoverageIncompleteReason[];
  evidenceDigest: string;
  gapDigest: string;
}

export interface CoverageSupersessionRecord {
  kind: typeof COVERAGE_SUPERSESSION_SCHEMA_KIND;
  version: "1";
  priorSealCommitSha: string;
  priorSealDigest: string;
  reason: string;
  overlappingEvidenceDigest: string;
  newEpochId: string | null;
  supersessionDigest: string;
}

export function activationHistoryProofRecordDigest(
  record: ActivationHistoryProofRecord,
): string {
  const relationship =
    record.claimedRelationship === "unverified"
      ? "unverified"
      : record.claimedRelationship;
  const evidenceDigest =
    record.evidenceDigest ??
    (relationship === "descendant" || relationship === "equal"
      ? computeHistoryProofEvidenceDigest({
          stateRepository: record.stateRepository,
          stateBranch: record.stateBranch,
          activationCommitSha: record.activationCommitSha,
          eventSnapshotCommitSha: record.eventSnapshotCommitSha,
          relationship,
          verifierVersion: "cursor-activation-history-verifier-v1",
        })
      : "");
  return createHash("sha256")
    .update(
      stableStringify({
        kind: record.kind,
        version: record.version,
        stateRepository: record.stateRepository,
        stateBranch: record.stateBranch,
        activationCommitSha: record.activationCommitSha,
        eventSnapshotCommitSha: record.eventSnapshotCommitSha,
        claimedRelationship: record.claimedRelationship,
        evidenceDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

export function buildPersistedCoverageSnapshotEnvelope(input: {
  epochId: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  activationHistoryProofCommitSha: string;
  activationHistoryProofDigest: string;
  snapshot: CoverageSnapshot;
  finalizationPolicyDigest?: string;
}): PersistedCoverageSnapshotEnvelope {
  if (input.snapshot.kind !== COVERAGE_SCHEMA_KIND) {
    throw new Error("coverage snapshot schema kind mismatch");
  }
  const partial: Omit<PersistedCoverageSnapshotEnvelope, "envelopeDigest"> = {
    kind: PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND,
    version: "1",
    epochId: input.epochId,
    activationCommitSha: input.activationCommitSha,
    eventSnapshotCommitSha: input.eventSnapshotCommitSha,
    activationHistoryProofCommitSha: input.activationHistoryProofCommitSha,
    activationHistoryProofDigest: input.activationHistoryProofDigest,
    snapshot: input.snapshot,
    ...(input.finalizationPolicyDigest
      ? { finalizationPolicyDigest: input.finalizationPolicyDigest }
      : {}),
  };
  const envelopeDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, envelopeDigest };
}

export function parsePersistedCoverageSnapshotEnvelope(
  bytes: string | object,
): PersistedCoverageSnapshotEnvelope {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as PersistedCoverageSnapshotEnvelope;
  if (
    parsed.kind !== PERSISTED_COVERAGE_SNAPSHOT_ENVELOPE_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid persisted coverage snapshot envelope");
  }
  const recomputed = buildPersistedCoverageSnapshotEnvelope({
    epochId: parsed.epochId,
    activationCommitSha: parsed.activationCommitSha,
    eventSnapshotCommitSha: parsed.eventSnapshotCommitSha,
    activationHistoryProofCommitSha: parsed.activationHistoryProofCommitSha,
    activationHistoryProofDigest: parsed.activationHistoryProofDigest,
    snapshot: parsed.snapshot,
    finalizationPolicyDigest: parsed.finalizationPolicyDigest,
  });
  if (recomputed.envelopeDigest !== parsed.envelopeDigest) {
    throw new Error("persisted coverage snapshot envelope digest mismatch");
  }
  return parsed;
}

export function buildCoverageSealRecord(input: {
  epochId: string;
  interval: CoverageInterval;
  coverageDigest: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  activationHistoryProofCommitSha: string;
  activationHistoryProofDigest: string;
  coverageSnapshotCommitSha: string;
  coverageSnapshotDigest: string;
  finalizationEvidenceDigest: string;
  operatorToolSourceSha: string;
  finalizationPolicyDigest?: string;
}): CoverageSealRecord {
  const partial: Omit<CoverageSealRecord, "sealDigest"> = {
    kind: COVERAGE_SEAL_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    interval: input.interval,
    coverageDigest: input.coverageDigest,
    activationCommitSha: input.activationCommitSha,
    eventSnapshotCommitSha: input.eventSnapshotCommitSha,
    activationHistoryProofCommitSha: input.activationHistoryProofCommitSha,
    activationHistoryProofDigest: input.activationHistoryProofDigest,
    coverageSnapshotCommitSha: input.coverageSnapshotCommitSha,
    coverageSnapshotDigest: input.coverageSnapshotDigest,
    finalizationEvidenceDigest: input.finalizationEvidenceDigest,
    operatorToolSourceSha: input.operatorToolSourceSha,
    ...(input.finalizationPolicyDigest
      ? { finalizationPolicyDigest: input.finalizationPolicyDigest }
      : {}),
  };
  const sealDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, sealDigest };
}

export function parseCoverageSealRecord(bytes: string | object): CoverageSealRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CoverageSealRecord;
  if (parsed.kind !== COVERAGE_SEAL_SCHEMA_KIND || parsed.version !== "1") {
    throw new Error("invalid coverage seal record");
  }
  const recomputed = buildCoverageSealRecord(parsed);
  if (recomputed.sealDigest !== parsed.sealDigest) {
    throw new Error("coverage seal digest mismatch");
  }
  return parsed;
}

export function gapRecordIdentityDigest(input: {
  epochId: string;
  intervalAttempted: CoverageInterval;
  incompleteReasons: readonly CoverageIncompleteReason[];
  evidenceDigest: string;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        epochId: input.epochId,
        intervalAttempted: input.intervalAttempted,
        incompleteReasons: [...input.incompleteReasons].sort(),
        evidenceDigest: input.evidenceDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

export function buildCoverageGapRecord(input: {
  epochId: string;
  intervalAttempted: CoverageInterval;
  incompleteReasons: CoverageIncompleteReason[];
  evidenceDigest: string;
}): CoverageGapRecord {
  const gapDigest = gapRecordIdentityDigest(input);
  return {
    kind: COVERAGE_GAP_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    intervalAttempted: input.intervalAttempted,
    incompleteReasons: [...input.incompleteReasons].sort(),
    evidenceDigest: input.evidenceDigest,
    gapDigest,
  };
}

export function parseCoverageGapRecord(bytes: string | object): CoverageGapRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CoverageGapRecord;
  if (parsed.kind !== COVERAGE_GAP_SCHEMA_KIND || parsed.version !== "1") {
    throw new Error("invalid coverage gap record");
  }
  const recomputed = buildCoverageGapRecord(parsed);
  if (recomputed.gapDigest !== parsed.gapDigest) {
    throw new Error("coverage gap digest mismatch");
  }
  return parsed;
}

export function supersessionRecordIdentityDigest(input: {
  priorSealCommitSha: string;
  priorSealDigest: string;
  reason: string;
  overlappingEvidenceDigest: string;
  newEpochId: string | null;
}): string {
  return createHash("sha256")
    .update(stableStringify(input), "utf8")
    .digest("hex");
}

export function buildCoverageSupersessionRecord(input: {
  priorSealCommitSha: string;
  priorSealDigest: string;
  reason: string;
  overlappingEvidenceDigest: string;
  newEpochId: string | null;
}): CoverageSupersessionRecord {
  const supersessionDigest = supersessionRecordIdentityDigest(input);
  return {
    kind: COVERAGE_SUPERSESSION_SCHEMA_KIND,
    version: "1",
    priorSealCommitSha: input.priorSealCommitSha,
    priorSealDigest: input.priorSealDigest,
    reason: input.reason,
    overlappingEvidenceDigest: input.overlappingEvidenceDigest,
    newEpochId: input.newEpochId,
    supersessionDigest,
  };
}

export function parseCoverageSupersessionRecord(
  bytes: string | object,
): CoverageSupersessionRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CoverageSupersessionRecord;
  if (
    parsed.kind !== COVERAGE_SUPERSESSION_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid coverage supersession record");
  }
  const recomputed = buildCoverageSupersessionRecord({
    priorSealCommitSha: parsed.priorSealCommitSha,
    priorSealDigest: parsed.priorSealDigest,
    reason: parsed.reason,
    overlappingEvidenceDigest: parsed.overlappingEvidenceDigest,
    newEpochId: parsed.newEpochId,
  });
  if (recomputed.supersessionDigest !== parsed.supersessionDigest) {
    throw new Error("coverage supersession digest mismatch");
  }
  return parsed;
}

export function persistedActivationRecordDigest(
  record: PersistedActivationRecord,
): string {
  if (
    record.kind !== ACTIVATION_RECORD_SCHEMA_KIND ||
    record.version !== "1"
  ) {
    throw new Error("invalid activation record schema");
  }
  return activationPayloadDigest(record.payload);
}

export function buildActivationHistoryProofRecord(input: {
  stateRepository: string;
  stateBranch: string;
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  claimedRelationship: ActivationHistoryProofRecord["claimedRelationship"];
}): ActivationHistoryProofRecord {
  const relationship =
    input.claimedRelationship === "unverified"
      ? "unverified"
      : input.claimedRelationship;
  const evidenceDigest =
    relationship === "descendant" || relationship === "equal"
      ? computeHistoryProofEvidenceDigest({
          stateRepository: input.stateRepository,
          stateBranch: input.stateBranch,
          activationCommitSha: input.activationCommitSha,
          eventSnapshotCommitSha: input.eventSnapshotCommitSha,
          relationship,
          verifierVersion: "cursor-activation-history-verifier-v1",
        })
      : undefined;
  return {
    kind: ACTIVATION_HISTORY_PROOF_KIND,
    version: "1",
    stateRepository: input.stateRepository,
    stateBranch: input.stateBranch,
    activationCommitSha: input.activationCommitSha,
    eventSnapshotCommitSha: input.eventSnapshotCommitSha,
    claimedRelationship: input.claimedRelationship,
    ...(evidenceDigest ? { evidenceDigest } : {}),
  };
}

export { activationPayloadDigest, type CanonicalActivationPayload };

export function buildEpochInvalidationRecord(input: {
  epochId: string;
  activationCommitSha: string;
  invalidInterval: CoverageInterval;
  reasons: string[];
  publicCanaryIdentities?: string[];
  workflowRunIds?: string[];
  eventCommitRange: {
    startCommitSha: string;
    endCommitSha: string;
  };
  gapId?: string | null;
  incidentId?: string | null;
  operatorToolSourceSha: string;
  improperPriorSeal?: ImproperPriorSealPin;
}): EpochInvalidationRecord {
  const partial: Omit<EpochInvalidationRecord, "invalidationDigest"> = {
    kind: EPOCH_INVALIDATION_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    activationCommitSha: input.activationCommitSha,
    invalidInterval: input.invalidInterval,
    reasons: [...input.reasons].sort(),
    publicCanaryIdentities: [...(input.publicCanaryIdentities ?? [])].sort(),
    workflowRunIds: [...(input.workflowRunIds ?? [])].sort(),
    eventCommitRange: input.eventCommitRange,
    gapId: input.gapId ?? null,
    incidentId: input.incidentId ?? null,
    operatorToolSourceSha: input.operatorToolSourceSha,
    ...(input.improperPriorSeal
      ? { improperPriorSeal: input.improperPriorSeal }
      : {}),
  };
  const invalidationDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, invalidationDigest };
}

export function parseEpochInvalidationRecord(
  bytes: string | object,
): EpochInvalidationRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as EpochInvalidationRecord;
  if (
    parsed.kind !== EPOCH_INVALIDATION_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid epoch invalidation record");
  }
  const recomputed = buildEpochInvalidationRecord(parsed);
  if (recomputed.invalidationDigest !== parsed.invalidationDigest) {
    throw new Error("epoch invalidation digest mismatch");
  }
  return parsed;
}

export function duplicateIncidentIdentityDigest(input: {
  epochId: string;
  recoveryOperationId: string;
  stage: string;
  attemptOrdinal: number;
  duplicateOperationId: string;
  priorOperationId: string;
  recordedAt: string;
}): string {
  return createHash("sha256")
    .update(stableStringify(input), "utf8")
    .digest("hex");
}

export function buildDuplicateOperationIncidentRecord(input: {
  epochId: string;
  recoveryOperationId: string;
  stage: string;
  attemptOrdinal: number;
  duplicateOperationId: string;
  priorOperationId: string;
  recordedAt: string;
}): DuplicateOperationIncidentRecord {
  const incidentDigest = duplicateIncidentIdentityDigest(input);
  return {
    kind: DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND,
    version: "1",
    epochId: input.epochId,
    recoveryOperationId: input.recoveryOperationId,
    stage: input.stage,
    attemptOrdinal: input.attemptOrdinal,
    duplicateOperationId: input.duplicateOperationId,
    priorOperationId: input.priorOperationId,
    recordedAt: input.recordedAt,
    incidentDigest,
  };
}

export function parseDuplicateOperationIncidentRecord(
  bytes: string | object,
): DuplicateOperationIncidentRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as DuplicateOperationIncidentRecord;
  if (
    parsed.kind !== DUPLICATE_OPERATION_INCIDENT_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid duplicate operation incident record");
  }
  const recomputed = buildDuplicateOperationIncidentRecord({
    epochId: parsed.epochId,
    recoveryOperationId: parsed.recoveryOperationId,
    stage: parsed.stage,
    attemptOrdinal: parsed.attemptOrdinal,
    duplicateOperationId: parsed.duplicateOperationId,
    priorOperationId: parsed.priorOperationId,
    recordedAt: parsed.recordedAt,
  });
  if (recomputed.incidentDigest !== parsed.incidentDigest) {
    throw new Error("duplicate operation incident digest mismatch");
  }
  return parsed;
}
