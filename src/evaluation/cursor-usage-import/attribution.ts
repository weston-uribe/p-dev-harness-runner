import type { PricingVariant } from "../telemetry/pricing-registry.js";
import {
  segmentKey,
  type AttributionCapability,
  type CanonicalUsageEvent,
  type UsageSegment,
} from "./canonical.js";
import { hashCloudAgentId } from "./parse.js";
import {
  normalizeModelRaw,
  resolveCanonicalModelId,
} from "./model-aliases.js";
import type { ObservedModelEvidence, PhaseJoinTarget, TokenBuckets } from "./types.js";
import type { UsageCandidate } from "./discovery.js";
import { addMicrosStrings, parseMicrosString } from "./money.js";
import {
  reconcileSourceModel,
  type ModelReconciliationOutcome,
} from "./model-reconciliation.js";

function observedModelsForCandidate(
  candidate: UsageCandidate,
): ObservedModelEvidence[] {
  if (candidate.observedModels?.length) return candidate.observedModels;
  if (!candidate.model?.trim()) return [];
  const rawModel = candidate.model;
  return [
    {
      rawModel,
      normalizedRawModel: normalizeModelRaw(rawModel),
      canonicalModelId: resolveCanonicalModelId(rawModel),
      variant: candidate.effectiveVariant ?? "unknown",
      observationIds: [],
    },
  ];
}

export type AttributionState =
  | "matched"
  | "unmatched"
  | "ambiguous"
  | "conflict"
  | "aggregate_only"
  | "rejected";

export interface SegmentReconciliationEvidence {
  outcome: ModelReconciliationOutcome;
  tokensAllowed: boolean;
  costAllowed: boolean;
  matchedCanonicalModelId: string | null;
  matchedNormalizedRawModel: string | null;
  matchedObservedVariant: PricingVariant | "unknown" | null;
  matchedObservationIds: string[];
  reason: string;
}

export interface AttributedSegment {
  segment: UsageSegment;
  state: AttributionState;
  candidate: UsageCandidate | null;
  reason?: string;
  reconciliation?: SegmentReconciliationEvidence;
}

export interface TraceUsageBundle {
  traceId: string;
  join: PhaseJoinTarget;
  tokens: TokenBuckets;
  segmentBreakdown: UsageSegment[];
  /** Matched attributed rows preserving reconciliation evidence for pricing. */
  attributedSegments: AttributedSegment[];
  matchedFingerprints: string[];
  states: AttributionState[];
}

const INGESTION_SLACK_MS = 6 * 60 * 60 * 1000;

function emptyTokens(): TokenBuckets {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function addTokens(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function parseIso(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function timestampsFitWindow(
  segment: UsageSegment,
  windowStart: string | null,
  windowEnd: string | null,
): boolean {
  if (!segment.timestampMin || !segment.timestampMax) return false;
  if (!windowStart || !windowEnd) return false;
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  const min = parseIso(segment.timestampMin);
  const max = parseIso(segment.timestampMax);
  if (start == null || end == null || min == null || max == null) return false;
  return min >= start - INGESTION_SLACK_MS && max <= end + INGESTION_SLACK_MS;
}

function costClassFromEvent(event: CanonicalUsageEvent): UsageSegment["billingSemantic"] {
  return event.billingCategory;
}

function markProviderAggregationFailure(
  seg: UsageSegment,
  reason: string,
): void {
  seg.providerActualUsdMicros = null;
  seg.providerActualAggregationComplete = false;
  seg.providerActualAggregationFailureReason = reason;
}

const TERMINAL_PROVIDER_FAILURES = new Set([
  "aggregation_overflow",
  "invalid_provider_actual_micros",
  "mixed_provider_actual_presence",
  "included_plan_amount",
]);

function aggregateProviderActual(
  seg: UsageSegment,
  event: CanonicalUsageEvent,
  billingSemantic: UsageSegment["billingSemantic"],
): void {
  if (
    seg.providerActualAggregationFailureReason &&
    TERMINAL_PROVIDER_FAILURES.has(seg.providerActualAggregationFailureReason)
  ) {
    return;
  }

  if (billingSemantic === "included_like" || event.includedInPlan === true) {
    markProviderAggregationFailure(seg, "included_plan_amount");
    return;
  }
  if (
    billingSemantic === "provider_cost_numeric_untyped" ||
    billingSemantic === "other" ||
    billingSemantic === "empty"
  ) {
    markProviderAggregationFailure(seg, `billing_semantic_${billingSemantic}`);
    return;
  }
  if (billingSemantic !== "provider_actual_usd") {
    if (event.providerActualUsdMicros) {
      markProviderAggregationFailure(
        seg,
        "untyped_or_unexpected_provider_amount",
      );
    }
    return;
  }
  if (!event.providerActualUsdMicros) {
    if (seg.providerActualUsdMicros != null) {
      markProviderAggregationFailure(seg, "mixed_provider_actual_presence");
    } else {
      markProviderAggregationFailure(seg, "missing_provider_actual_amount");
    }
    return;
  }
  const parsed = parseMicrosString(event.providerActualUsdMicros);
  if (!parsed.ok) {
    markProviderAggregationFailure(
      seg,
      parsed.reason === "overflow"
        ? "aggregation_overflow"
        : "invalid_provider_actual_micros",
    );
    return;
  }
  if (seg.providerActualUsdMicros == null) {
    seg.providerActualUsdMicros = parsed.microsString;
    seg.providerActualAggregationComplete = true;
    seg.providerActualAggregationFailureReason = null;
    return;
  }
  const summed = addMicrosStrings(
    seg.providerActualUsdMicros,
    parsed.microsString,
  );
  if (!summed.ok) {
    markProviderAggregationFailure(
      seg,
      summed.reason === "overflow"
        ? "aggregation_overflow"
        : "invalid_provider_actual_micros",
    );
    return;
  }
  seg.providerActualUsdMicros = summed.microsString;
  seg.providerActualAggregationComplete = true;
  seg.providerActualAggregationFailureReason = null;
}

/**
 * Build per-agent model segments from canonical usage events.
 * Admin aggregate_only events are retained for analytics but marked separately at attribution.
 * Provider-actual micros never retain a partial sum after aggregation failure.
 */
export function buildSegmentsFromCanonicalEvents(
  events: CanonicalUsageEvent[],
): UsageSegment[] {
  const buckets = new Map<string, UsageSegment>();

  for (const event of events) {
    if (!event.cloudAgentId) continue;
    const modelIdCanonical =
      event.modelIdCanonical ?? resolveCanonicalModelId(event.modelRaw);
    const billingSemantic = costClassFromEvent(event);
    const key = segmentKey({
      cloudAgentId: event.cloudAgentId,
      modelIdCanonical,
      modelRaw: event.modelRaw,
      billingSemantic,
    });

    let seg = buckets.get(key);
    if (!seg) {
      seg = {
        cloudAgentId: event.cloudAgentId,
        cloudAgentIdHash: hashCloudAgentId(event.cloudAgentId),
        modelRaw: event.modelRaw,
        modelIdCanonical,
        billingSemantic,
        tokens: emptyTokens(),
        rowCount: 0,
        fingerprints: [],
        timestampMin: null,
        timestampMax: null,
        providerActualUsdMicros: null,
        providerActualAggregationComplete: false,
        providerActualAggregationFailureReason: "no_provider_actual_amounts",
        sourceMaxMode: event.sourceMaxMode,
      };
      buckets.set(key, seg);
    }

    if (!seg.fingerprints.includes(event.sourceEventFingerprint)) {
      seg.fingerprints.push(event.sourceEventFingerprint);
      seg.tokens = addTokens(seg.tokens, event.tokens);
      seg.rowCount += 1;
      if (
        !seg.timestampMin ||
        (event.timestampIso && event.timestampIso < seg.timestampMin)
      ) {
        seg.timestampMin = event.timestampIso;
      }
      if (
        !seg.timestampMax ||
        (event.timestampIso && event.timestampIso > seg.timestampMax)
      ) {
        seg.timestampMax = event.timestampIso;
      }
      aggregateProviderActual(seg, event, billingSemantic);
    }
  }

  for (const seg of buckets.values()) {
    seg.fingerprints.sort();
    // Segments with rows but never a typed provider amount stay incomplete.
    if (
      seg.rowCount > 0 &&
      seg.providerActualUsdMicros == null &&
      seg.providerActualAggregationFailureReason == null
    ) {
      seg.providerActualAggregationComplete = false;
      seg.providerActualAggregationFailureReason = "no_provider_actual_amounts";
    }
  }
  return [...buckets.values()];
}

function segmentCapability(segment: UsageSegment, events: CanonicalUsageEvent[]): AttributionCapability {
  const fps = new Set(segment.fingerprints);
  for (const e of events) {
    if (fps.has(e.sourceEventFingerprint)) {
      return e.capability;
    }
  }
  return "issue_phase_scores";
}

function evidenceFromReconciliation(
  reconciliation: ReturnType<typeof reconcileSourceModel>,
): SegmentReconciliationEvidence {
  const matched = reconciliation.matchedObserved;
  return {
    outcome: reconciliation.outcome,
    tokensAllowed: reconciliation.tokensAllowed,
    costAllowed: reconciliation.costAllowed,
    matchedCanonicalModelId: matched?.canonicalModelId ?? null,
    matchedNormalizedRawModel: matched?.normalizedRawModel ?? null,
    matchedObservedVariant: matched?.variant ?? null,
    matchedObservationIds: matched ? [...matched.observationIds].sort() : [],
    reason: reconciliation.reason,
  };
}

/**
 * Attribute each usage segment to at most one Langfuse candidate trace.
 */
export function attributeSegmentsToCandidates(params: {
  segments: UsageSegment[];
  candidates: UsageCandidate[];
  canonicalEvents?: CanonicalUsageEvent[];
}): AttributedSegment[] {
  const events = params.canonicalEvents ?? [];
  const byAgent = new Map<string, UsageCandidate[]>();
  for (const c of params.candidates) {
    if (!c.cursorAgentId) continue;
    const list = byAgent.get(c.cursorAgentId) ?? [];
    list.push(c);
    byAgent.set(c.cursorAgentId, list);
  }

  return params.segments.map((segment) => {
    const capability = segmentCapability(segment, events);
    if (capability === "aggregate_only") {
      return {
        segment,
        state: "aggregate_only" as const,
        candidate: null,
        reason: "admin_aggregate_only",
      };
    }

    const cands = (byAgent.get(segment.cloudAgentId) ?? []).filter((c) =>
      timestampsFitWindow(segment, c.windowStart, c.windowEnd),
    );

    if (cands.length === 0) {
      return {
        segment,
        state: "unmatched" as const,
        candidate: null,
        reason: "no_candidate_for_agent",
      };
    }

    const traceIds = new Set(cands.map((c) => c.traceId));
    if (traceIds.size > 1) {
      return {
        segment,
        state: "ambiguous" as const,
        candidate: null,
        reason: "multiple_traces_for_agent",
      };
    }

    const phases = new Set(cands.map((c) => c.phase).filter(Boolean));
    if (phases.size > 1) {
      return {
        segment,
        state: "ambiguous" as const,
        candidate: null,
        reason: "multiple_phases_for_agent",
      };
    }

    const candidate = cands[0]!;
    if (!candidate.effectiveVariant || !candidate.phase) {
      return {
        segment,
        state: "rejected" as const,
        candidate: null,
        reason: "candidate_missing_variant_or_phase",
      };
    }

    const reconciliation = reconcileSourceModel({
      sourceModelRaw: segment.modelRaw,
      sourceModelCanonical: segment.modelIdCanonical,
      observedModels: observedModelsForCandidate(candidate),
      multiModelExecutionProven: candidate.multiModelExecutionProven === true,
      candidateVariant: candidate.effectiveVariant,
    });
    const reconciliationEvidence = evidenceFromReconciliation(reconciliation);

    if (
      reconciliation.outcome === "model_identity_conflict" ||
      reconciliation.outcome === "variant_identity_conflict"
    ) {
      return {
        segment,
        state: "conflict" as const,
        candidate: null,
        reason: reconciliation.reason,
        reconciliation: reconciliationEvidence,
      };
    }

    if (!reconciliation.tokensAllowed) {
      return {
        segment,
        state: "rejected" as const,
        candidate: null,
        reason: reconciliation.reason,
        reconciliation: reconciliationEvidence,
      };
    }

    return {
      segment,
      state: "matched" as const,
      candidate,
      reason: reconciliation.outcome,
      reconciliation: reconciliationEvidence,
    };
  });
}

function traceEndTimestamp(candidate: UsageCandidate): string {
  return candidate.windowEnd ?? candidate.timestamp ?? new Date(0).toISOString();
}

/**
 * Bundle matched segments by traceId. Multi-model segments for one agent collapse
 * into one trace bundle with segmentBreakdown preserved.
 * Never includes aggregate_only segments in score-bound bundles.
 */
export function bundleAttributedSegments(params: {
  attributed: AttributedSegment[];
  namespace: string;
}): {
  bundles: TraceUsageBundle[];
  skipped: Array<{ reason: string; cloudAgentIdHash?: string; phase?: string }>;
} {
  const skipped: Array<{ reason: string; cloudAgentIdHash?: string; phase?: string }> = [];
  const byTrace = new Map<
    string,
    {
      candidate: UsageCandidate;
      attributedSegments: AttributedSegment[];
      states: AttributionState[];
    }
  >();

  for (const row of params.attributed) {
    if (row.state === "aggregate_only") {
      continue;
    }
    if (row.state !== "matched" || !row.candidate) {
      skipped.push({
        reason: row.reason ?? `segment_${row.state}`,
        cloudAgentIdHash: row.segment.cloudAgentIdHash,
      });
      continue;
    }

    const traceId = row.candidate.traceId;
    const existing = byTrace.get(traceId);
    if (existing && existing.candidate.cursorAgentId !== row.candidate.cursorAgentId) {
      skipped.push({
        reason: "conflict_multiple_agents_on_trace",
        cloudAgentIdHash: row.segment.cloudAgentIdHash,
        phase: row.candidate.phase ?? undefined,
      });
      continue;
    }

    const bucket = existing ?? {
      candidate: row.candidate,
      attributedSegments: [] as AttributedSegment[],
      states: [] as AttributionState[],
    };
    bucket.attributedSegments.push(row);
    bucket.states.push(row.state);
    byTrace.set(traceId, bucket);
  }

  const bundles: TraceUsageBundle[] = [];
  for (const [traceId, bucket] of byTrace) {
    const candidate = bucket.candidate;
    if (!candidate.cursorAgentId || !candidate.phase || !candidate.effectiveVariant) {
      skipped.push({
        reason: "bundle_missing_join_fields",
        cloudAgentIdHash: candidate.cursorAgentIdHash ?? undefined,
      });
      continue;
    }

    let tokens = emptyTokens();
    for (const row of bucket.attributedSegments) {
      tokens = addTokens(tokens, row.segment.tokens);
    }

    const join: PhaseJoinTarget = {
      phase: candidate.phase,
      traceId,
      traceEndTimestamp: traceEndTimestamp(candidate),
      harnessRunId: candidate.harnessRunId,
      phaseExecutionId: candidate.phaseExecutionId,
      cursorAgentId: candidate.cursorAgentId,
      cursorAgentIdHash: hashCloudAgentId(candidate.cursorAgentId),
      effectiveVariant: candidate.effectiveVariant as PricingVariant,
      sdkFast: candidate.effectiveVariant === "fast",
      windowStart: candidate.windowStart,
      windowEnd: candidate.windowEnd,
    };

    const segments = bucket.attributedSegments.map((r) => r.segment);
    bundles.push({
      traceId,
      join,
      tokens,
      segmentBreakdown: segments,
      attributedSegments: bucket.attributedSegments,
      matchedFingerprints: segments.flatMap((s) => s.fingerprints),
      states: bucket.states,
    });
  }

  return { bundles, skipped };
}
