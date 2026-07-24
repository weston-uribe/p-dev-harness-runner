import type { CoverageInterval } from "../coverage.js";

/** Forward-compatible lifecycle types for coverage seal and late-evidence scans. */

export const COVERAGE_SEAL_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-seal.v1" as const;

export interface CoverageSealRecord {
  kind: typeof COVERAGE_SEAL_SCHEMA_KIND;
  version: "1";
  sealedAt: string;
  sealCommitSha: string;
  coverageSnapshotCommitSha: string;
  coverageInterval: CoverageInterval;
  coverageDigest: string;
  activationEpochId: string;
  eventSnapshotCommitSha: string;
  registrySnapshotCommitSha: string;
  sealDigest: string;
}

export const COVERAGE_INVALIDATION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-invalidation.v1" as const;

export interface CoverageInvalidationRecord {
  kind: typeof COVERAGE_INVALIDATION_SCHEMA_KIND;
  version: "1";
  invalidatedAt: string;
  sealCommitSha: string;
  reasonCode: string;
  evidenceDigest: string;
}

export const COVERAGE_SUPERSESSION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-coverage-supersession.v1" as const;

export interface CoverageSupersessionRecord {
  kind: typeof COVERAGE_SUPERSESSION_SCHEMA_KIND;
  version: "1";
  supersededAt: string;
  priorSealCommitSha: string;
  successorSealCommitSha: string;
  evidenceDigest: string;
}

export type LateEvidenceKind =
  | "provenance_event"
  | "reconciliation_record"
  | "gap_record"
  | "workflow_install"
  | "runner_install"
  | "divergence_evidence"
  | "invalidation"
  | "supersession";

export interface LateEvidenceItem {
  kind: LateEvidenceKind;
  commitSha: string;
  path: string;
  /** Possible activity start (inclusive) when known. */
  activityStartInclusive: string | null;
  /** Possible activity end (exclusive) when known. */
  activityEndExclusive: string | null;
  contentDigest: string;
}
