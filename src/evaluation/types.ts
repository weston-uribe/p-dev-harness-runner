import type { FinalOutcome } from "../types/run.js";
import type { EvaluationPhase } from "./phases.js";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
/** Default Langfuse projection profile (hashes/refs/metadata only). */
export const EVALUATION_CAPTURE_PROFILE_METADATA = "metadata-v1" as const;
/** Opt-in Langfuse projection with bounded redacted human-readable content. */
export const EVALUATION_CAPTURE_PROFILE_CONTENT = "content-v1" as const;
/** @deprecated Prefer EVALUATION_CAPTURE_PROFILE_METADATA — kept for import compatibility. */
export const EVALUATION_CAPTURE_PROFILE = EVALUATION_CAPTURE_PROFILE_METADATA;
export const EVALUATION_PROVIDER_LANGFUSE = "langfuse" as const;

export type EvaluationCaptureProfile =
  | typeof EVALUATION_CAPTURE_PROFILE_METADATA
  | typeof EVALUATION_CAPTURE_PROFILE_CONTENT;
export type EvaluationProviderName = typeof EVALUATION_PROVIDER_LANGFUSE;

export type EvaluationScoreName =
  | "phase_success"
  | "revision_required"
  | "revision_cycle_count"
  | "review_outcome"
  | "merge_completed"
  | "delivery_outcome"
  | "merged_to_dev"
  | "promoted_to_main"
  | "production_deployment_started"
  | "production_deployment_ready"
  | "production_verified"
  | "cursor_input_tokens"
  | "cursor_cache_read_tokens"
  | "cursor_cache_write_tokens"
  | "cursor_output_tokens"
  | "cursor_total_tokens"
  | "cursor_token_usage_complete"
  | "cursor_source_scope_complete"
  | "cursor_known_noncache_cost_usd"
  | "cursor_all_input_at_list_rate_usd"
  | "cursor_cost_proxy_available"
  | "cursor_list_price_equivalent_usd"
  | "cursor_list_price_equivalent_complete"
  | "cursor_provider_actual_usd"
  | "cursor_provider_actual_cost_complete"
  | "cursor_exact_cost_complete"
  | "cursor_generation_native_usage_complete";

export type EvaluationScoreDataType = "BOOLEAN" | "NUMERIC" | "CATEGORICAL";

export type EvaluationScoreClass = "operational" | "cursor_usage_import";

/**
 * Optional public-safe structured score metadata.
 *
 * Privacy contract:
 * - No full Cloud Agent IDs, emails, secrets, raw CSV paths, or API keys.
 * - Prefer hashed agent IDs (≤12 hex) and digest prefixes.
 * - Values should be strings/numbers/booleans; keep object shallow (≤2 levels)
 *   and total serialized size modest (callers enforce ≤2 KiB).
 * - Authoritative provenance remains in the private import ledger; metadata is
 *   a compact public-safe projection. Do not assume Langfuse indexes metadata
 *   for search unless separately proven.
 */
export type EvaluationScoreMetadata = Record<string, unknown>;

export interface EvaluationScoreInput {
  id: string;
  target: "trace" | "session";
  traceId?: string;
  sessionId?: string;
  name: EvaluationScoreName;
  dataType: EvaluationScoreDataType;
  value: boolean | number | string;
  timestamp: string;
  /**
   * Optional bounded privacy-safe comment. Must not contain issue keys, agent IDs,
   * CSV paths, repos, or private correlation values. When omitted, runtime uses
   * the default operational classification comment.
   * Cursor usage import comments are capped at 480 characters.
   */
  comment?: string;
  scoreClass?: EvaluationScoreClass;
  /** Optional public-safe structured provenance (see EvaluationScoreMetadata). */
  metadata?: EvaluationScoreMetadata;
  /** Optional Langfuse environment when supported by the score-create body. */
  environment?: string;
}

export interface EvaluationCorrelation {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  provider: EvaluationProviderName;
  captureProfile: EvaluationCaptureProfile;
  sessionId: string;
  traceId: string;
}

export type ObservationKind =
  | "span"
  | "event"
  | "agent"
  | "generation"
  | "tool";

/** Rich observation attributes (Langfuse projection; content gated by capture profile). */
export interface ObservationUpdateAttrs {
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
}

export interface PhaseFinishSummary {
  finalOutcome: FinalOutcome;
  errorClassification: string | null;
  linearStatusAfter: string | null;
  prCreated: boolean;
  previewAvailable: boolean;
  changedFileCount: number | null;
}

export interface NestedObservationHandle {
  update(attrs?: ObservationUpdateAttrs | Record<string, unknown>): void;
  end(attrs?: ObservationUpdateAttrs | Record<string, unknown>): void;
  startChild(name: string, kind?: ObservationKind): NestedObservationHandle;
}

export interface PhaseTraceHandle {
  readonly correlation: EvaluationCorrelation;
  startChild(name: string, kind?: ObservationKind): NestedObservationHandle;
  /** Set root trace input/output (content projection gated by capture profile). */
  setIO?(input?: unknown, output?: unknown): void;
  finish(
    summary: PhaseFinishSummary,
    metadata?: Record<string, unknown>,
  ): void;
  /** Forward a canonical telemetry event into Langfuse nested observations. */
  onTelemetryEvent?(event: import("./telemetry/types.js").AgentTelemetryEvent): void;
}

export interface StartPhaseTraceInput {
  phase: EvaluationPhase;
  issueKey: string;
  runId: string;
  metadata?: Record<string, unknown>;
  /** Linear team key for allowlisted identity (never issue body). */
  linearTeamKey?: string | null;
  /** 1-based revision/repair cycle when applicable. */
  revisionCycleIndex?: number | null;
  /** Stable phase execution id for correlation. */
  phaseExecutionId?: string | null;
}

export interface EvaluationRuntime {
  readonly enabled: boolean;
  readonly namespace: string;
  startPhaseTrace(input: StartPhaseTraceInput): Promise<PhaseTraceHandle | null>;
  recordScore(input: EvaluationScoreInput): void;
  /**
   * Production-effect path: create score and await flush.
   * Throws on create/flush failure. Idempotent retries use the same score id.
   */
  recordAcknowledgedScore(input: EvaluationScoreInput): Promise<void>;
  flushAndShutdown(): Promise<void>;
}

export interface EvaluationRuntimeConfig {
  provider: EvaluationProviderName;
  captureProfile: EvaluationCaptureProfile;
  namespace: string;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  tracingEnvironment: string;
  release: string | null;
}
