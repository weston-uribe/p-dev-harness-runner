import type { CoverageInterval, CoverageSnapshot } from "../../../provenance/coverage.js";
import type { CoverageSealRecord } from "../../../provenance/coverage-lifecycle-schemas.js";

/** Registry reader output contract version. */
export const CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION = "1" as const;

/** Importer provenance-scope manifest contract version. */
export const CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION = "1" as const;

/** Registry-to-CSV join contract version. */
export const CURSOR_USAGE_REGISTRY_TO_CSV_JOIN_CONTRACT_VERSION = "1" as const;

/** Coverage exclusion manifest contract version. */
export const CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION = "1" as const;

/** Versioned CSV-event-to-run temporal contract (§D). */
export const CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION = "1" as const;

/**
 * Fixed attribution slack for registry run-operation windows.
 * Must match {@link INGESTION_SLACK_MS} in attribution.ts (6 hours).
 */
export const registryEventAttributionSlackMs = 6 * 60 * 60 * 1000;

export type OwnershipClassification =
  | "harness_owned"
  | "proven_outside_harness_scope"
  | "harness_owned_missing_langfuse_trace"
  | "registry_ambiguous"
  | "coverage_incomplete"
  | "registry_integrity_failure";

export type TraceMappingClassification =
  | "exact_trace_match"
  | "target_trace_missing"
  | "target_trace_ambiguous"
  | "phase_identity_conflict"
  | "model_identity_conflict"
  | "variant_identity_conflict"
  | "execution_window_conflict"
  | "trace_identity_conflict";

export type TerminalRunOutcome =
  | "completed"
  | "failed"
  | "reconciled_closed"
  | "permanently_unresolvable"
  | "unresolved";

/** Hash-only run-operation binding projected from registry events. */
export interface RunOperationBinding {
  launchAttemptId: string;
  agentHash: string;
  providerRunOperationId: string;
  runHash: string | null;
  linearIssueKey: string | null;
  phase: string | null;
  harnessRunId: string | null;
  phaseExecutionId: string | null;
  launchSurface: string | null;
  sendSurface: string | null;
  sendOrdinal: number | null;
  activityStartInclusive: string | null;
  activityEndExclusive: string | null;
  terminalOutcome: TerminalRunOutcome;
  coverageEpochId: string | null;
}

export interface RegistryPin {
  stateRepository: string;
  stateBranch: string;
  /** Immutable registry snapshot commit (event set + activation + seal). */
  registrySnapshotCommitSha: string;
  activationCommitSha: string;
  activationHistoryProofCommitSha: string | null;
  coverageSealCommitSha: string;
  coverageSnapshotCommitSha: string;
}

export interface RegistryIntegrityFailure {
  code: string;
  detail: string;
}

export interface RegistryReadResult {
  pin: RegistryPin;
  readerSchemaVersion: typeof CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION;
  activationEpochId: string | null;
  activationPayloadDigest: string | null;
  activationHistoryProofDigest: string | null;
  eventSnapshotCommitSha: string;
  eventSetDigest: string;
  registrySnapshotDigest: string;
  sealedInterval: CoverageInterval | null;
  coverageSnapshot: CoverageSnapshot | null;
  coverageDigest: string | null;
  sealDigest: string | null;
  sealRecord: CoverageSealRecord | null;
  runOperationBindings: RunOperationBinding[];
  includedAgentHashDigest: string;
  includedRunOperationSetDigest: string;
  integrityFailures: RegistryIntegrityFailure[];
  integrityOk: boolean;
}

export interface SourceSegmentRef {
  segmentKey: string;
  cloudAgentIdHash: string;
  agentHash: string;
  timestampMin: string | null;
  timestampMax: string | null;
  rowCount: number;
  fingerprints: string[];
}

export interface SegmentOwnershipResult {
  segment: SourceSegmentRef;
  classification: OwnershipClassification;
  reasonCode: string | null;
  compatibleRunOperations: RunOperationBinding[];
  matchedRunOperation: RunOperationBinding | null;
}

export interface OutsideScopeExclusionEntry {
  segmentKey: string;
  agentHashPrefix: string;
  timestampMin: string | null;
  timestampMax: string | null;
  reasonCode: "not_in_complete_pdev_linear_harness_registry";
}

export interface OutsideScopeExclusionManifest {
  contractVersion: typeof CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION;
  entries: OutsideScopeExclusionEntry[];
  digest: string;
}

export interface ExactTraceTarget {
  segmentKey: string;
  traceId: string;
  agentHash: string;
  linearIssueKey: string;
  phase: string;
  phaseExecutionId: string | null;
  harnessRunId: string | null;
  runHash: string | null;
  windowStart: string;
  windowEnd: string;
  canonicalModelId: string | null;
  variant: string | null;
}

export interface TraceMappingResult {
  segmentKey: string;
  classification: TraceMappingClassification;
  reasonCode: string | null;
  target: ExactTraceTarget | null;
}

export interface ProvenanceScopeManifest {
  contractVersion: typeof CURSOR_USAGE_PROVENANCE_SCOPE_CONTRACT_VERSION;
  joinContractVersion: typeof CURSOR_USAGE_REGISTRY_TO_CSV_JOIN_CONTRACT_VERSION;
  exclusionContractVersion: typeof CURSOR_USAGE_COVERAGE_EXCLUSION_CONTRACT_VERSION;
  timeContractVersion: typeof CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION;
  registryEventAttributionSlackMs: number;
  readerSchemaVersion: typeof CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION;
  pin: RegistryPin;
  activationEpochId: string | null;
  activationPayloadDigest: string | null;
  activationHistoryProofDigest: string | null;
  activationHistoryProofCommitSha: string | null;
  eventSetDigest: string;
  registrySnapshotDigest: string;
  sealedInterval: CoverageInterval | null;
  coverageDigest: string | null;
  sealDigest: string | null;
  includedAgentHashDigest: string;
  includedRunOperationSetDigest: string;
  outsideScopeExclusionDigest: string;
  exactTargetTraceDigest: string;
  segmentOwnershipDigest: string;
  traceMappingDigest: string;
  dispositionManifestDigest: string | null;
  manifestDigest: string;
}

export interface LateEvidenceScanResult {
  sealCommitSha: string;
  tipCommitSha: string;
  sealedInterval: CoverageInterval;
  overlappingEvidence: Array<{
    kind: string;
    commitSha: string;
    path: string;
    contentDigest: string;
  }>;
  enumerationComplete: boolean;
  applyBlocked: boolean;
  reasonCode: string | null;
}
