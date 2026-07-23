import type { AttributedSegment, TraceUsageBundle } from "./attribution.js";
import type { ExpectedScoreManifest } from "./expected-score-manifest.js";
import type {
  LedgerAnalyticsGroupMetrics,
  LedgerAnalyticsSummary,
} from "./staging.js";
import type { PhaseImportAttachment } from "./types.js";
import { normalizeModelRaw, resolveCanonicalModelId } from "./model-aliases.js";
import { PRICING_REGISTRY_VERSION } from "../telemetry/pricing-registry.js";

function emptyGroup(): LedgerAnalyticsGroupMetrics {
  return {
    bundles: 0,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    providerActualUsd: null,
    knownNoncacheCostUsd: null,
    allInputAtListRateUsd: null,
    completeness: "incomplete",
    coverage: "incomplete_import",
  };
}

function addTokens(
  cur: LedgerAnalyticsGroupMetrics,
  tokens: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
  },
  bundleDelta: number,
): void {
  cur.bundles += bundleDelta;
  cur.inputTokens += tokens.inputTokens;
  cur.cacheWriteTokens += tokens.cacheWriteTokens;
  cur.cacheReadTokens += tokens.cacheReadTokens;
  cur.outputTokens += tokens.outputTokens;
  cur.totalTokens += tokens.totalTokens;
}

function scoreNumeric(
  scores: PhaseImportAttachment["scores"],
  name: string,
): number | null {
  const s = scores.find((x) => x.name === name);
  if (!s || typeof s.value !== "number" || !Number.isFinite(s.value)) return null;
  return s.value;
}

function applyUsd(
  cur: LedgerAnalyticsGroupMetrics,
  provider: number | null,
  known: number | null,
  allInput: number | null,
  complete: boolean,
): void {
  if (!complete) {
    cur.completeness = "incomplete";
    cur.coverage =
      cur.coverage === "verified" ? "mixed" : "incomplete_import";
    cur.providerActualUsd = null;
    cur.knownNoncacheCostUsd = null;
    cur.allInputAtListRateUsd = null;
    return;
  }
  cur.completeness =
    cur.completeness === "incomplete" && cur.bundles > 1
      ? "incomplete"
      : "complete";
  cur.coverage = cur.coverage === "incomplete_import" && cur.bundles > 1
    ? "mixed"
    : "verified";
  if (provider != null) {
    cur.providerActualUsd = (cur.providerActualUsd ?? 0) + provider;
  }
  if (known != null) {
    cur.knownNoncacheCostUsd = (cur.knownNoncacheCostUsd ?? 0) + known;
  }
  if (allInput != null) {
    cur.allInputAtListRateUsd = (cur.allInputAtListRateUsd ?? 0) + allInput;
  }
}

/**
 * Build a public-safe analytics summary for the current import lifecycle.
 * Verified totals are populated only when `verifiedTotals` is true.
 * Incomplete diagnostics are always counted from attributed/skipped state.
 */
export function buildLedgerAnalyticsSummary(params: {
  importId: string;
  sourceDigestSha256: string;
  verifiedTotals: boolean;
  attachments: PhaseImportAttachment[];
  bundles: TraceUsageBundle[];
  attributed: AttributedSegment[];
  skipped: Array<{ reason: string }>;
  expectedScoreManifest: ExpectedScoreManifest | null;
  pricingIncompleteSegmentCount: number;
  issueKeyByTraceId: Record<string, string>;
}): LedgerAnalyticsSummary {
  void params.expectedScoreManifest;
  const byIssue: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const byPhase: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const bySourceModel: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const byCanonicalModel: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const byEffectiveVariant: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const bySourceDigest: Record<string, LedgerAnalyticsGroupMetrics> = {};
  const byPricingRegistryVersion: Record<string, LedgerAnalyticsGroupMetrics> =
    {};

  const digestKey = params.sourceDigestSha256.slice(0, 16);
  const pricingRegistryKey = PRICING_REGISTRY_VERSION;

  let unresolvedSegmentCount = 0;
  for (const a of params.attributed) {
    if (a.state !== "matched" && a.state !== "aggregate_only") {
      unresolvedSegmentCount += 1;
    }
  }
  unresolvedSegmentCount += params.skipped.filter(
    (s) =>
      !params.attributed.some(
        (a) => (a.reason ?? `segment_${a.state}`) === s.reason,
      ),
  ).length;
  // Prefer attributed non-matched count as authoritative.
  unresolvedSegmentCount = params.attributed.filter(
    (a) => a.state !== "matched" && a.state !== "aggregate_only",
  ).length;

  if (params.verifiedTotals) {
    for (const attachment of params.attachments) {
      const issue =
        params.issueKeyByTraceId[attachment.join.traceId] || "unknown";
      const phase = attachment.join.phase;
      const tokens = attachment.aggregate.tokens;
      const provider = scoreNumeric(
        attachment.scores,
        "cursor_provider_actual_usd",
      );
      const known = scoreNumeric(
        attachment.scores,
        "cursor_known_noncache_cost_usd",
      );
      const allInput = scoreNumeric(
        attachment.scores,
        "cursor_all_input_at_list_rate_usd",
      );
      const complete = attachment.scores.some(
        (s) => s.name === "cursor_source_scope_complete" && s.value === true,
      );

      const bumpBundle = (
        map: Record<string, LedgerAnalyticsGroupMetrics>,
        key: string,
      ) => {
        const cur = map[key] ?? emptyGroup();
        addTokens(cur, tokens, 1);
        applyUsd(cur, provider, known, allInput, complete);
        map[key] = cur;
      };

      bumpBundle(byIssue, issue);
      bumpBundle(byPhase, phase);
      bumpBundle(bySourceDigest, digestKey);
      bumpBundle(byPricingRegistryVersion, pricingRegistryKey);

      const bundle = params.bundles.find(
        (b) => b.traceId === attachment.join.traceId,
      );
      if (bundle) {
        for (const row of bundle.attributedSegments) {
          const segTokens = row.segment.tokens;
          const raw =
            row.reconciliation?.matchedNormalizedRawModel ??
            normalizeModelRaw(row.segment.modelRaw);
          const canonical =
            row.reconciliation?.matchedCanonicalModelId ??
            row.segment.modelIdCanonical ??
            resolveCanonicalModelId(row.segment.modelRaw) ??
            "unresolved";
          const variant = String(
            row.reconciliation?.matchedObservedVariant ??
              attachment.join.effectiveVariant,
          );

          for (const [map, key] of [
            [bySourceModel, raw],
            [byCanonicalModel, canonical],
            [byEffectiveVariant, variant],
          ] as const) {
            const cur = map[key] ?? emptyGroup();
            addTokens(cur, segTokens, 0);
            // Count one bundle contribution per unique attachment once via flags.
            if (cur.bundles === 0) cur.bundles = 1;
            applyUsd(cur, null, null, null, complete);
            map[key] = cur;
          }
        }
      }
    }
  }

  return {
    byIssue,
    byPhase,
    bySourceModel,
    byCanonicalModel,
    byEffectiveVariant,
    bySourceDigest,
    byPricingRegistryVersion,
    sourceDigestPrefix: digestKey,
    importId: params.importId,
    pricingRegistryVersion: pricingRegistryKey,
    unresolvedSegmentCount,
    pricingIncompleteSegmentCount: params.pricingIncompleteSegmentCount,
    verifiedTotalsIncluded: params.verifiedTotals,
  };
}
