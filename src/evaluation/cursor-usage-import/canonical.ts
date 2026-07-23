import { createHash } from "node:crypto";
import type { PricingVariant } from "../telemetry/pricing-registry.js";
import { resolveCanonicalModelId } from "./model-aliases.js";
import type { TokenBuckets } from "./types.js";

export const CANONICAL_USAGE_SCHEMA_VERSION = 2 as const;
export const SCORE_CONTRACT_VERSION = "11.0.0" as const;

export type CanonicalSourceType = "cursor_csv" | "cursor_admin_api";

export type ProviderCostClass =
  | "included_like"
  | "provider_actual_usd"
  | "provider_cost_numeric_untyped"
  | "empty"
  | "other"
  | "aggregate_only";

export type AttributionCapability = "issue_phase_scores" | "aggregate_only";

export interface CanonicalUsageEvent {
  sourceType: CanonicalSourceType;
  sourceSchemaVersion: number;
  importerVersion: string;
  sourceEventFingerprint: string;
  sourceDigestOrQueryId: string;
  timestampIso: string;
  cloudAgentId: string | null;
  automationId: string | null;
  modelRaw: string;
  modelIdCanonical: string | null;
  sourceMaxMode: string | null;
  sourceFastHint: "true" | "false" | "unknown";
  kind: string | null;
  billingCategory: ProviderCostClass;
  tokens: TokenBuckets;
  /** Base-10 integer string of micro-USD when typed USD actual is known. */
  providerActualUsdMicros: string | null;
  isTokenBased: boolean | null;
  includedInPlan: boolean;
  capability: AttributionCapability;
  warnings: string[];
}

export interface UsageSegment {
  cloudAgentId: string;
  cloudAgentIdHash: string;
  modelRaw: string;
  modelIdCanonical: string | null;
  billingSemantic: ProviderCostClass;
  tokens: TokenBuckets;
  rowCount: number;
  fingerprints: string[];
  timestampMin: string | null;
  timestampMax: string | null;
  providerActualUsdMicros: string | null;
  /** True only when every contributing typed amount summed without failure. */
  providerActualAggregationComplete: boolean;
  /** Public-safe reason when aggregation is incomplete; null when complete. */
  providerActualAggregationFailureReason: string | null;
  sourceMaxMode: string | null;
}

export interface ExportWindow {
  startIso: string;
  endIso: string;
  timezone: string;
  precision: "second" | "millisecond" | "day" | "unknown";
  boundsSource:
    | "operator_gui_fields"
    | "cli_flags"
    | "csv_embedded"
    | "csv_row_extrema"
    | "unproven";
}

export function fingerprintCanonicalParts(
  parts: Array<string | number | null | undefined>,
): string {
  return createHash("sha256")
    .update(parts.map((p) => (p == null ? "" : String(p))).join("|"))
    .digest("hex");
}

export function deriveSourceFastHint(
  maxMode: string | null | undefined,
): "true" | "false" | "unknown" {
  // Max Mode ≠ Fast Mode. Never map maxMode → fast.
  void maxMode;
  return "unknown";
}

export function eventFromCsvRow(params: {
  importerVersion: string;
  sourceDigest: string;
  timestampIso: string;
  cloudAgentId: string;
  automationId: string;
  model: string;
  maxMode: string;
  kind: string;
  tokens: TokenBuckets;
  costClass: ProviderCostClass;
  fingerprint: string;
}): CanonicalUsageEvent {
  const modelIdCanonical = resolveCanonicalModelId(params.model);
  return {
    sourceType: "cursor_csv",
    sourceSchemaVersion: CANONICAL_USAGE_SCHEMA_VERSION,
    importerVersion: params.importerVersion,
    sourceEventFingerprint: params.fingerprint,
    sourceDigestOrQueryId: params.sourceDigest,
    timestampIso: params.timestampIso,
    cloudAgentId: params.cloudAgentId || null,
    automationId: params.automationId || null,
    modelRaw: params.model,
    modelIdCanonical,
    sourceMaxMode: params.maxMode || null,
    sourceFastHint: deriveSourceFastHint(params.maxMode),
    kind: params.kind || null,
    billingCategory: params.costClass,
    tokens: params.tokens,
    providerActualUsdMicros: null,
    isTokenBased: null,
    includedInPlan: params.costClass === "included_like",
    capability: "issue_phase_scores",
    warnings:
      params.costClass === "provider_cost_numeric_untyped"
        ? ["provider_cost_numeric_untyped"]
        : [],
  };
}

export type EffectiveVariantKey = PricingVariant | "unknown";

export function segmentKey(params: {
  cloudAgentId: string;
  modelIdCanonical: string | null;
  modelRaw: string;
  billingSemantic: ProviderCostClass;
}): string {
  return [
    params.cloudAgentId,
    params.modelIdCanonical ?? normalizeRaw(params.modelRaw),
    params.billingSemantic,
  ].join("\u0000");
}

function normalizeRaw(s: string): string {
  return s.trim().toLowerCase();
}
