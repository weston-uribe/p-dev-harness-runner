import type { LangfuseInspectReport } from "../langfuse-inspect/types.js";
import {
  isEvaluationPhase,
  phaseInvokesAgent,
  type EvaluationPhase,
} from "../phases.js";
import type { PricingVariant } from "../telemetry/pricing-registry.js";
import { hashCloudAgentId } from "./parse.js";
import type {
  AgentAggregate,
  AllowedImportPhase,
  PhaseJoinTarget,
} from "./types.js";

const INGESTION_SLACK_MS = 6 * 60 * 60 * 1000;

export type { AllowedImportPhase };

function parseIso(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function resolveVariantFromMeta(metadata: Record<string, unknown>): {
  variant: PricingVariant | null;
  fast: boolean | null;
} {
  const ev = metadata.effectiveVariant;
  if (ev === "standard" || ev === "fast") {
    return { variant: ev, fast: ev === "fast" };
  }
  if (metadata.fast === true || metadata.fast === "true") {
    return { variant: "fast", fast: true };
  }
  if (metadata.fast === false || metadata.fast === "false") {
    return { variant: "standard", fast: false };
  }
  return { variant: null, fast: null };
}

function agentIdFromObs(
  obs: LangfuseInspectReport["traces"][number]["observations"][number],
): string | null {
  if (typeof obs.agentId === "string" && obs.agentId.length > 8) {
    return obs.agentId;
  }
  const meta = obs.metadata.cursorAgentId;
  if (typeof meta === "string" && meta.length > 8) return meta;
  return null;
}

function resolveObsPhase(
  obs: LangfuseInspectReport["traces"][number]["observations"][number],
  tracePhase: string | null,
): AllowedImportPhase | null {
  const raw =
    obs.phase ||
    (typeof obs.metadata.phase === "string" ? obs.metadata.phase : null) ||
    tracePhase;
  if (!raw || !isEvaluationPhase(raw)) return null;
  if (!phaseInvokesAgent(raw)) return null;
  return raw;
}

function traceEndTimestamp(
  trace: LangfuseInspectReport["traces"][number],
): string {
  let max: string | null = null;
  for (const obs of trace.observations) {
    const t = obs.endTime ?? obs.startTime;
    if (t && (!max || t > max)) max = t;
  }
  return max ?? trace.timestamp ?? new Date(0).toISOString();
}

function timestampsFitWindow(
  aggregate: AgentAggregate,
  obsStart: string | null,
  obsEnd: string | null,
): boolean {
  if (!aggregate.timestampMin || !aggregate.timestampMax) return false;
  if (!obsStart || !obsEnd) return false;
  const start = parseIso(obsStart);
  const end = parseIso(obsEnd);
  const min = parseIso(aggregate.timestampMin);
  const max = parseIso(aggregate.timestampMax);
  if (start == null || end == null || min == null || max == null) return false;
  return min >= start - INGESTION_SLACK_MS && max <= end + INGESTION_SLACK_MS;
}

export function parseAllowedImportPhases(
  phases: string[] | undefined,
): AllowedImportPhase[] {
  if (!phases?.length) {
    return [];
  }
  const out: AllowedImportPhase[] = [];
  for (const p of phases) {
    const trimmed = p.trim();
    if (!isEvaluationPhase(trimmed)) continue;
    if (!phaseInvokesAgent(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function defaultAllowedImportPhases(): AllowedImportPhase[] {
  return (
    [
      "planning",
      "plan_review",
      "code_review",
      "code_revision",
      "implementation",
      "revision",
      "integration_repair",
    ] as EvaluationPhase[]
  ).filter(phaseInvokesAgent);
}

export interface JoinResult {
  joins: Array<{ join: PhaseJoinTarget; aggregate: AgentAggregate }>;
  skipped: Array<{ reason: string; cloudAgentIdHash?: string; phase?: string }>;
}

/**
 * Join agent aggregates to exactly one allowed agent-invoking phase trace each.
 */
export function joinAggregatesToPhaseTraces(params: {
  report: LangfuseInspectReport;
  aggregates: AgentAggregate[];
  allowedPhases: AllowedImportPhase[];
}): JoinResult {
  const { report, aggregates, allowedPhases } = params;
  const skipped: JoinResult["skipped"] = [];
  const joins: JoinResult["joins"] = [];

  type Candidate = {
    phase: AllowedImportPhase;
    traceId: string;
    traceEndTimestamp: string;
    harnessRunId: string | null;
    phaseExecutionId: string | null;
    cursorAgentId: string;
    effectiveVariant: PricingVariant;
    sdkFast: boolean;
    windowStart: string | null;
    windowEnd: string | null;
  };

  const byAgent = new Map<string, Candidate[]>();

  for (const trace of report.traces) {
    type AgentWin = {
      phases: Set<AllowedImportPhase>;
      windowStart: string | null;
      windowEnd: string | null;
      harnessRunId: string | null;
      phaseExecutionId: string | null;
    };
    const agentsOnTrace = new Map<string, AgentWin>();
    let variant: PricingVariant | null = null;
    let fast: boolean | null = null;

    for (const obs of trace.observations) {
      const obsPhase = resolveObsPhase(obs, trace.phase);
      const aid = agentIdFromObs(obs);
      if (aid && obsPhase && allowedPhases.includes(obsPhase)) {
        const cur = agentsOnTrace.get(aid) ?? {
          phases: new Set<AllowedImportPhase>(),
          windowStart: null,
          windowEnd: null,
          harnessRunId: null,
          phaseExecutionId: null,
        };
        cur.phases.add(obsPhase);
        if (
          obs.startTime &&
          (!cur.windowStart || obs.startTime < cur.windowStart)
        ) {
          cur.windowStart = obs.startTime;
        }
        const end = obs.endTime ?? obs.startTime;
        if (end && (!cur.windowEnd || end > cur.windowEnd)) {
          cur.windowEnd = end;
        }
        cur.harnessRunId =
          cur.harnessRunId ?? obs.harnessRunId ?? trace.harnessRunId;
        cur.phaseExecutionId =
          cur.phaseExecutionId ?? obs.phaseExecutionId ?? trace.phaseExecutionId;
        agentsOnTrace.set(aid, cur);
      }
      if (!variant) {
        const r = resolveVariantFromMeta(obs.metadata);
        if (r.variant) {
          variant = r.variant;
          fast = r.fast;
        }
      }
    }

    if (agentsOnTrace.size === 0) continue;

    if (!variant) {
      for (const aid of agentsOnTrace.keys()) {
        skipped.push({
          reason: "effective_variant_unknown",
          cloudAgentIdHash: hashCloudAgentId(aid),
        });
      }
      continue;
    }

    for (const [aid, win] of agentsOnTrace) {
      if (win.phases.size !== 1) {
        skipped.push({
          reason: "ambiguous_multi_phase_mapping",
          cloudAgentIdHash: hashCloudAgentId(aid),
        });
        continue;
      }
      const phase = [...win.phases][0]!;
      const list = byAgent.get(aid) ?? [];
      if (list.some((c) => c.traceId === trace.id)) continue;
      list.push({
        phase,
        traceId: trace.id,
        traceEndTimestamp: traceEndTimestamp(trace),
        harnessRunId: win.harnessRunId,
        phaseExecutionId: win.phaseExecutionId,
        cursorAgentId: aid,
        effectiveVariant: variant,
        sdkFast: fast === true,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
      });
      byAgent.set(aid, list);
    }
  }

  for (const aggregate of aggregates) {
    const cands = (byAgent.get(aggregate.cloudAgentId) ?? []).filter((c) =>
      allowedPhases.includes(c.phase),
    );
    if (cands.length === 0) {
      skipped.push({
        reason: "no_phase_trace_for_agent",
        cloudAgentIdHash: aggregate.cloudAgentIdHash,
      });
      continue;
    }
    const phases = new Set(cands.map((c) => c.phase));
    if (phases.size > 1) {
      skipped.push({
        reason: "ambiguous_multi_phase_mapping",
        cloudAgentIdHash: aggregate.cloudAgentIdHash,
      });
      continue;
    }
    const traces = new Set(cands.map((c) => c.traceId));
    if (traces.size > 1) {
      skipped.push({
        reason: "ambiguous_multi_trace_mapping",
        cloudAgentIdHash: aggregate.cloudAgentIdHash,
        phase: cands[0]!.phase,
      });
      continue;
    }
    const cand = cands[0]!;
    if (!timestampsFitWindow(aggregate, cand.windowStart, cand.windowEnd)) {
      skipped.push({
        reason: "timestamps_outside_execution_window",
        cloudAgentIdHash: aggregate.cloudAgentIdHash,
        phase: cand.phase,
      });
      continue;
    }
    joins.push({
      aggregate,
      join: {
        phase: cand.phase,
        traceId: cand.traceId,
        traceEndTimestamp: cand.traceEndTimestamp,
        harnessRunId: cand.harnessRunId,
        phaseExecutionId: cand.phaseExecutionId,
        cursorAgentId: cand.cursorAgentId,
        cursorAgentIdHash: hashCloudAgentId(cand.cursorAgentId),
        effectiveVariant: cand.effectiveVariant,
        sdkFast: cand.sdkFast,
        windowStart: cand.windowStart,
        windowEnd: cand.windowEnd,
      },
    });
  }

  return { joins, skipped };
}

/**
 * Validate that each phase present in joins has exactly one canonical
 * score-target trace. Does not require every allowed phase to appear
 * (source-scope completeness ≠ universal workflow phase coverage).
 */
export function validateCanonicalCsvPhaseTraces(params: {
  joins: JoinResult["joins"];
  allowedPhases: AllowedImportPhase[];
  /** When true, also require every allowed phase to have a join (legacy). */
  requireAllAllowedPhases?: boolean;
}): {
  ok: boolean;
  skipped: JoinResult["skipped"];
  canonicalTraceByPhase: Map<AllowedImportPhase, string>;
} {
  const skipped: JoinResult["skipped"] = [];
  const canonicalTraceByPhase = new Map<AllowedImportPhase, string>();
  const phasesToCheck = params.requireAllAllowedPhases
    ? params.allowedPhases
    : ([
        ...new Set(params.joins.map((j) => j.join.phase)),
      ] as AllowedImportPhase[]);

  for (const phase of phasesToCheck) {
    const phaseJoins = params.joins.filter((j) => j.join.phase === phase);
    if (phaseJoins.length === 0) {
      skipped.push({ reason: `missing_csv_score_trace:${phase}`, phase });
      continue;
    }
    const traceIds = [...new Set(phaseJoins.map((j) => j.join.traceId))];
    if (traceIds.length > 1) {
      skipped.push({
        reason: `ambiguous_csv_score_trace:${phase}`,
        phase,
      });
      if (phaseJoins.length > 1) {
        skipped.push({
          reason: `csv_scores_split_across_traces:${phase}`,
          phase,
        });
      }
      continue;
    }
    canonicalTraceByPhase.set(phase, traceIds[0]!);
  }

  return {
    ok: skipped.length === 0,
    skipped,
    canonicalTraceByPhase,
  };
}
