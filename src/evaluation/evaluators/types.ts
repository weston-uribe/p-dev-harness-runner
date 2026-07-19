import type { AnnotationValue } from "../annotations/types.js";
import type { ArtifactRef } from "../telemetry/types.js";
import type {
  EvaluationSubject,
  EvaluationSubjectPhase,
  EvaluationSubjectType,
} from "../subjects/types.js";
import type { RunManifest } from "../../types/run.js";
import type { AgentTelemetryEvent } from "../telemetry/types.js";

/**
 * Deterministic evaluator / future LLM-judge result contract.
 * Distinct from HumanAnnotation — never stored as annotation source.
 */

export type EvaluatorResultStatus =
  | "pass"
  | "fail"
  | "error"
  | "skipped";

export type EvaluatorSkipReason =
  | "not_applicable"
  | "insufficient_evidence"
  | "dependency_unavailable"
  | null;

export const EVALUATOR_RESULT_SCHEMA_VERSION = 1 as const;
export const EVALUATOR_ENGINE_VERSION = "evaluator-engine-v1" as const;

export interface EvaluatorResult {
  evaluatorResultSchemaVersion: typeof EVALUATOR_RESULT_SCHEMA_VERSION;
  evaluatorResultId: string;
  evaluationSubjectId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorImplementationHash: string;
  rubricId: string;
  rubricVersion: string;
  rubricDefinitionHash: string;
  dimensionId: string;
  status: EvaluatorResultStatus;
  /** Required for pass/fail; null for skipped/error. */
  result: AnnotationValue | null;
  skipReason: EvaluatorSkipReason;
  /** Bounded machine-readable reason; separate from explanation. */
  reasonCode: string;
  evidenceReferences: ArtifactRef[];
  missingEvidence: string[];
  untrustedEvidence: string[];
  explanation: string;
  startedAt: string;
  completedAt: string;
  executionDurationMs: number;
  engineVersion: string;
  sourceHarnessRelease: string | null;
  sourceHarnessCommit: string | null;
  evaluationPolicyVersion: string | null;
  evaluationPolicyHash: string | null;
  evidenceFingerprint: string;
  supersedesEvaluatorResultId?: string | null;
  /** Optional workflow state-machine provenance for workflow evaluators. */
  workflowStateMachineVersion?: string | null;
  workflowStateMachineHash?: string | null;
}

export interface EvaluatorDependency {
  evaluatorId: string;
  /** Acceptable evaluator versions (exact strings). */
  acceptableVersions: string[];
}

export type EvaluatorDeterminism = "pure";

export interface EvaluatorOutcome {
  status: EvaluatorResultStatus;
  result?: AnnotationValue | null;
  skipReason?: EvaluatorSkipReason;
  reasonCode: string;
  explanation: string;
  evidenceReferences?: ArtifactRef[];
  missingEvidence?: string[];
  untrustedEvidence?: string[];
  workflowStateMachineVersion?: string | null;
  workflowStateMachineHash?: string | null;
}

export interface ResolvedEvidenceItem {
  key: string;
  present: boolean;
  required: boolean;
  optional: boolean;
  path: string | null;
  sha256: string | null;
  /** Canonical marker when absent. */
  absenceMarker: "absent" | null;
  untrusted: boolean;
  untrustedReason: string | null;
  /** Bounded verified content when safe and requested. */
  content: string | null;
}

export interface EvaluationContext {
  subject: EvaluationSubject;
  sessionSubjects: EvaluationSubject[];
  logDirectory: string;
  issueKey: string;
  evaluationDirectory: string;
  runDirectory: string | null;
  manifest: RunManifest | null;
  manifestsByRunId: Record<string, RunManifest>;
  telemetryEvents: AgentTelemetryEvent[];
  telemetryCompleteness: unknown | null;
  evidence: Record<string, ResolvedEvidenceItem>;
  dependencyResults: EvaluatorResult[];
  rubricDefinitionHash: string;
  evaluatorImplementationHash: string;
  evaluationPolicyVersion: string | null;
  evaluationPolicyHash: string | null;
  now: () => string;
}

export interface EvaluatorDefinition {
  evaluatorId: string;
  evaluatorVersion: string;
  implementationVersion: string;
  /** Resolved from implementation manifest at registry load. */
  implementationHash: string;
  applicableSubjectTypes: EvaluationSubjectType[];
  applicablePhases: EvaluationSubjectPhase[] | null;
  rubricId: string;
  rubricVersion: string;
  dimensionId: string;
  requiredEvidence: string[];
  optionalEvidence: string[];
  /** Optional evidence keys whose absence affects fingerprint/behavior. */
  optionalEvidenceAffectsBehavior?: string[];
  dependencies: EvaluatorDependency[];
  determinism: EvaluatorDeterminism;
  /** Relative module path used for manifest hashing (under evaluators/). */
  sourceModule: string;
  evaluate: (ctx: EvaluationContext) => Promise<EvaluatorOutcome> | EvaluatorOutcome;
}

export interface EvaluatorPlanEntry {
  evaluationSubjectId: string;
  subjectType: EvaluationSubjectType;
  phase: EvaluationSubjectPhase | null;
  evaluatorId: string;
  evaluatorVersion: string;
  dimensionId: string;
  rubricId: string;
  rubricVersion: string;
  reason: "applicable" | "filtered";
}

export type ForcedAttemptOutcome =
  | "reused_equivalent"
  | "deterministic_violation";

export interface EvaluatorForcedAttempt {
  evaluatorResultId: string;
  evaluationSubjectId: string;
  evaluatorId: string;
  outcome: ForcedAttemptOutcome;
  detail: string;
}

export interface EvaluatorRunReport {
  schemaVersion: 1;
  engineVersion: string;
  evaluationPolicyVersion: string | null;
  evaluationPolicyHash: string | null;
  issueKey: string;
  evaluationSessionId: string;
  startedAt: string;
  completedAt: string;
  dryRun: boolean;
  subjectsConsidered: string[];
  evaluatorsSelected: Array<{
    evaluatorId: string;
    evaluatorVersion: string;
    dimensionId: string;
  }>;
  resultsAppended: number;
  resultsReused: number;
  forcedAttempts: EvaluatorForcedAttempt[];
  counts: {
    pass: number;
    fail: number;
    skipped: number;
    error: number;
    skippedNotApplicable: number;
    skippedInsufficientEvidence: number;
    skippedDependencyUnavailable: number;
  };
  missingEvidenceSummary: Record<string, number>;
  untrustedEvidenceSummary: Record<string, number>;
  durationByEvaluator: Record<string, number>;
  warnings: string[];
}

export interface EvaluatorSummaryArtifact {
  schemaVersion: 1;
  engineVersion: string;
  evaluationPolicyVersion: string | null;
  evaluationPolicyHash: string | null;
  issueKey: string;
  evaluationSessionId: string;
  computedAt: string;
  effectiveResultsBySubject: Record<string, string[]>;
  resultsByRubricDimension: Record<string, Record<string, string>>;
  totals: {
    pass: number;
    fail: number;
    skipped: number;
    error: number;
  };
  failingContractChecks: Array<{
    evaluationSubjectId: string;
    evaluatorId: string;
    dimensionId: string;
    reasonCode: string;
  }>;
  missingEvidenceChecks: Array<{
    evaluationSubjectId: string;
    evaluatorId: string;
    dimensionId: string;
  }>;
  evaluatorVersionDistribution: Record<string, number>;
  nonCurrentForPolicy: Array<{
    evaluatorResultId: string;
    evaluationSubjectId: string;
    evaluatorId: string;
    evaluatorVersion: string;
  }>;
  subjectsWithNoApplicableEvaluators: string[];
}
