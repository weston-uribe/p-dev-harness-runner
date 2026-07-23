import type { EvaluationScoreInput } from "../types.js";
import type { EvaluationPhase } from "../phases.js";
import type { PricingVariant } from "../telemetry/pricing-registry.js";
import type { TraceScoreFetchEvidence } from "../langfuse-inspect/client.js";
import type { ExportWindow } from "./canonical.js";

export const CURSOR_USAGE_CSV_SCHEMA_VERSION = 1 as const;
export const CURSOR_USAGE_IMPORTER_VERSION = "13.0.1" as const;

/** Reserved durable producer field on agent observation metadata (contract B). */
export const MULTI_MODEL_EXECUTION_PROVEN_FIELD =
  "multiModelExecutionProven" as const;

export interface ObservedModelEvidence {
  rawModel: string;
  normalizedRawModel: string;
  canonicalModelId: string | null;
  variant: PricingVariant | "unknown";
  observationIds: string[];
}

export const ALL_INPUT_AT_LIST_RATE_COMMENT =
  "comparison proxy; all input categories valued at published non-cache input list rate" as const;

export const CURSOR_USAGE_SCORE_NAMES = [
  "cursor_input_tokens",
  "cursor_cache_read_tokens",
  "cursor_cache_write_tokens",
  "cursor_output_tokens",
  "cursor_total_tokens",
  "cursor_token_usage_complete",
  "cursor_source_scope_complete",
  "cursor_known_noncache_cost_usd",
  "cursor_all_input_at_list_rate_usd",
  "cursor_cost_proxy_available",
  "cursor_list_price_equivalent_usd",
  "cursor_list_price_equivalent_complete",
  "cursor_provider_actual_usd",
  "cursor_provider_actual_cost_complete",
  "cursor_exact_cost_complete",
  "cursor_generation_native_usage_complete",
] as const;

export type CursorUsageScoreName = (typeof CURSOR_USAGE_SCORE_NAMES)[number];

export interface TokenBuckets {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type CsvCostCategory =
  | "included_like"
  | "provider_cost_numeric_untyped"
  | "empty"
  | "other";

export interface CsvRowNormalized {
  fingerprint: string;
  timestampIso: string;
  cloudAgentId: string;
  automationId: string;
  kind: string;
  model: string;
  maxMode: string;
  tokens: TokenBuckets;
  /** Legacy alias mapping: numeric Cost cells are untyped until USD is proven. */
  costCategory: CsvCostCategory;
}

export interface AgentAggregate {
  cloudAgentId: string;
  cloudAgentIdHash: string;
  rowCount: number;
  fingerprints: string[];
  models: string[];
  tokens: TokenBuckets;
  costCategories: Record<string, number>;
  timestampMin: string | null;
  timestampMax: string | null;
}

export type AllowedImportPhase = EvaluationPhase;

export interface PhaseJoinTarget {
  phase: AllowedImportPhase;
  traceId: string;
  traceEndTimestamp: string;
  harnessRunId: string | null;
  phaseExecutionId: string | null;
  cursorAgentId: string;
  cursorAgentIdHash: string;
  effectiveVariant: PricingVariant;
  sdkFast: boolean;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface PhaseImportAttachment {
  join: PhaseJoinTarget;
  aggregate: AgentAggregate;
  proxies: {
    knownNoncacheCostUsd: number;
    allInputAtListRateUsd: number;
    pricingRegistryVersion: string;
    effectiveVariant: PricingVariant;
  };
  scores: EvaluationScoreInput[];
}

export interface CursorUsageImportVerdicts {
  tokenAcceptance: boolean;
  costProxyAvailability: boolean;
  exactMonetaryCostAcceptance: boolean;
  tokenAcceptanceReason: string;
  costProxyAvailabilityReason: string;
  exactMonetaryCostAcceptanceReason: string;
}

export interface CursorUsageImportPreview {
  previewOnly: true;
  wouldAttachPhaseCount: number;
  wouldWriteScoreCount: number;
  localArithmeticValid: boolean;
  localAttributionValid: boolean;
  readAfterWriteVerified: false;
}

export interface CursorUsageImportReadAfterWrite {
  verified: boolean;
  logicalScoreCountFirst: number;
  logicalScoreCountSecond: number | null;
  physicalMatchingScoreCountFirst: number;
  physicalMatchingScoreCountSecond: number | null;
  uniqueMatchingDeterministicIdsFirst: number;
  uniqueMatchingDeterministicIdsSecond: number | null;
  physicalRecordsMatchingExpectedTraceNameFirst: number;
  physicalRecordsMatchingExpectedTraceNameSecond: number | null;
  duplicatePhysicalRecordCountFirst: number;
  duplicatePhysicalRecordCountSecond: number | null;
  unrelatedPreExistingScoreCountFirst: number;
  unrelatedPreExistingScoreCountSecond: number | null;
  expectedDeterministicScoreIds: string[];
  retrievalCompletenessProvenFirst: boolean;
  retrievalCompletenessProvenSecond: boolean | null;
  fetchEvidenceFirst?: TraceScoreFetchEvidence[];
  fetchEvidenceSecond?: TraceScoreFetchEvidence[];
  mismatches: string[];
}

export interface CursorUsageImportPrivateReport {
  schemaVersion: 1;
  kind: "cursor_usage_import_private";
  preparedAt: string;
  importerVersion: typeof CURSOR_USAGE_IMPORTER_VERSION;
  csvSchemaVersion: typeof CURSOR_USAGE_CSV_SCHEMA_VERSION;
  issueKey: string;
  namespace: string;
  csvDigestSha256: string;
  exportWindow?: ExportWindow | null;
  sourceScopeComplete?: boolean;
  sourceScopeIncompleteReason?: string | null;
  dryRun: boolean;
  arithmeticValid: boolean;
  rowsParsed: number;
  distinctAgents: number;
  attachments: Array<{
    phase: string;
    traceId: string;
    cloudAgentIdHash: string;
    matchedRowCount: number;
    fingerprints: string[];
    tokens: TokenBuckets;
    proxies: PhaseImportAttachment["proxies"];
    scoreIds: string[];
    scoreTimestamp: string;
    attributionRationale: string;
    effectiveVariant: PricingVariant;
  }>;
  skipped: Array<{ reason: string; cloudAgentIdHash?: string; phase?: string }>;
  observationMutationAttempted: false;
  verdicts: CursorUsageImportVerdicts;
  preview?: CursorUsageImportPreview;
  readAfterWrite?: CursorUsageImportReadAfterWrite;
  publicSummary: CursorUsageImportPublicSummary;
}

export interface CursorUsageImportPublicSummary {
  schemaVersion: 1;
  kind: "cursor_usage_import_public";
  importerVersion: typeof CURSOR_USAGE_IMPORTER_VERSION;
  dryRun: boolean;
  previewOnly?: boolean;
  arithmeticValid: boolean;
  localArithmeticValid?: boolean;
  localAttributionValid?: boolean;
  wouldAttachPhaseCount?: number;
  wouldWriteScoreCount?: number;
  readAfterWriteVerified?: boolean;
  phasesAttached: string[];
  attachmentCount: number;
  observationMutationAttempted: false;
  tokenAcceptance: boolean;
  costProxyAvailability: boolean;
  exactMonetaryCostAcceptance: boolean;
  generationCostCompleteUnchanged: true;
}
