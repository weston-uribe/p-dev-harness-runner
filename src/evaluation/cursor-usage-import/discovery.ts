import { createHash } from "node:crypto";
import { isEvaluationPhase, phaseInvokesAgent } from "../phases.js";
import { deriveSessionId } from "../identifiers.js";
import type { PricingVariant } from "../telemetry/pricing-registry.js";
import {
  metadataString,
  type LangfuseApiClient,
  type LangfuseRequestOptions,
} from "../langfuse-inspect/client.js";
import { hashCloudAgentId } from "./parse.js";
import { normalizeModelRaw, resolveCanonicalModelId } from "./model-aliases.js";
import { digestCanonical } from "./expected-score-manifest.js";
import {
  CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
  CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
  CURSOR_USAGE_OBSERVATION_MAX_PAGES,
  CURSOR_USAGE_OBSERVATION_MAX_RECORDS,
  CURSOR_USAGE_OBSERVATION_PAGE_LIMIT,
  CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION,
  CURSOR_USAGE_OBSERVATION_V2_FIELDS,
  CURSOR_USAGE_TRACE_LIST_FIELDS,
  CURSOR_USAGE_TRACE_MAX_PAGES,
  CURSOR_USAGE_TRACE_MAX_RECORDS,
  CURSOR_USAGE_TRACE_PAGE_LIMIT,
  CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION,
  DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION,
} from "./discovery-constants.js";
import {
  CURSOR_USAGE_SCORE_NAMES,
  MULTI_MODEL_EXECUTION_PROVEN_FIELD,
  type AllowedImportPhase,
  type ObservedModelEvidence,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolveVariantFromMeta(
  metadata: Record<string, unknown>,
): PricingVariant | null {
  const ev = metadata.effectiveVariant;
  if (ev === "standard" || ev === "fast") return ev;
  if (metadata.fast === true || metadata.fast === "true") return "fast";
  if (metadata.fast === false || metadata.fast === "false") return "standard";
  return null;
}

function agentIdFromObs(obs: Record<string, unknown>): string | null {
  if (typeof obs.agentId === "string" && obs.agentId.length > 8) {
    return obs.agentId;
  }
  const meta = asRecord(obs.metadata);
  const cursorAgentId = meta ? metadataString(meta, "cursorAgentId") : null;
  if (cursorAgentId && cursorAgentId.length > 8) return cursorAgentId;
  return null;
}

function resolveObsPhase(
  obs: Record<string, unknown>,
  tracePhase: string | null,
): AllowedImportPhase | null {
  const meta = asRecord(obs.metadata);
  const raw =
    (typeof obs.phase === "string" ? obs.phase : null) ??
    (meta ? metadataString(meta, "phase") : null) ??
    tracePhase;
  if (!raw || !isEvaluationPhase(raw)) return null;
  if (!phaseInvokesAgent(raw)) return null;
  return raw;
}

function issueKeyFromTrace(trace: Record<string, unknown>): string | null {
  const direct =
    metadataString(trace, "linearIssueKey") ??
    metadataString(trace, "issueKey") ??
    (typeof trace.linearIssueKey === "string" ? trace.linearIssueKey : null);
  if (direct?.trim()) return direct.trim();
  const meta = asRecord(trace.metadata);
  if (!meta) return null;
  return (
    metadataString(meta, "linearIssueKey") ?? metadataString(meta, "issueKey")
  );
}

function issueKeyFromObservations(
  observations: Array<Record<string, unknown>>,
): string | null {
  const keys = new Set<string>();
  for (const obs of observations) {
    const meta = asRecord(obs.metadata);
    const key =
      (meta
        ? metadataString(meta, "linearIssueKey") ??
          metadataString(meta, "issueKey")
        : null) ??
      (typeof obs.linearIssueKey === "string" ? obs.linearIssueKey : null) ??
      (typeof obs.issueKey === "string" ? obs.issueKey : null);
    if (key?.trim()) keys.add(key.trim());
  }
  if (keys.size !== 1) return null;
  return [...keys][0]!;
}

function resolveIssueKey(params: {
  trace: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
}): string | null {
  return (
    issueKeyFromTrace(params.trace) ??
    issueKeyFromObservations(params.observations)
  );
}

function rawModelFromObs(obs: Record<string, unknown>): string | null {
  if (typeof obs.providedModelName === "string" && obs.providedModelName.trim()) {
    return obs.providedModelName.trim();
  }
  if (typeof obs.model === "string" && obs.model.trim()) {
    return obs.model.trim();
  }
  const meta = asRecord(obs.metadata);
  if (meta && typeof meta.model === "string" && meta.model.trim()) {
    return meta.model.trim();
  }
  return null;
}

export interface UsageCandidate {
  traceId: string;
  sessionId: string | null;
  timestamp: string | null;
  cursorAgentId: string | null;
  cursorAgentIdHash: string | null;
  issueKey: string;
  phase: AllowedImportPhase | null;
  phaseExecutionId: string | null;
  harnessRunId: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  model: string | null;
  effectiveVariant: PricingVariant | null;
  /** Non-authoritative preflight diagnostic from shallow trace-list scores. */
  existingCursorScoreNames: string[];
  observedModels: ObservedModelEvidence[];
  observedModelIds: string[];
  multiModelExecutionProven: boolean;
  multiModelProofField: typeof MULTI_MODEL_EXECUTION_PROVEN_FIELD;
}

export interface DiscoveryRequestCounters {
  discoveryInvocationId: string;
  traceListRequestCount: number;
  /** Window-scoped Observations API v2 requests (production). */
  observationRequestCount: number;
  /** Always 0 on production path; oracle may increment separately. */
  perTraceObservationRequestCount: number;
}

export interface DatasetRetrievalEvidence {
  complete: boolean;
  truncationReason?: string;
  pagesFetched: number;
  recordsFetched: number;
  duplicateIdenticalCount: number;
  duplicateDivergentCount: number;
  pageLimit: number;
  maxPages: number;
  maxRecords: number;
}

export interface DeterministicDiscoveryEvidence {
  schemaVersion: typeof DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION;
  algorithmVersion: typeof CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION;
  tracePaginationContractVersion: typeof CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION;
  observationPaginationContractVersion: typeof CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION;
  observationEligibilityContract: typeof CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT;
  namespace: string;
  environmentFilter: string | null;
  traceFromTimestamp: string;
  traceToTimestamp: string;
  observationFromStartTime: string;
  observationToStartTime: string;
  sourceCoverageSafetyMarginMs: number;
  traceRetrieval: DatasetRetrievalEvidence;
  observationRetrieval: DatasetRetrievalEvidence;
  tracesDigest: string;
  retainedObservationsDigest: string;
  candidateSnapshotDigest: string;
  viableCandidateCount: number;
  distinctCandidateAgentHashCount: number;
  observationsFetched: number;
  targetObservationsRetained: number;
  observationsWithoutTraceId: number;
}

export interface DiscoverUsageCandidatesResult {
  candidates: UsageCandidate[];
  /** Overall: both trace and observation retrieval complete. */
  retrievalComplete: boolean;
  truncationReason?: string;
  pagesFetched: number;
  tracesFetched: number;
  observationPagesFetched?: number;
  observationsFetched?: number;
  targetObservationsRetained?: number;
  algorithmVersion?: typeof CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION;
  /** Required for production path; synthesized for injected test discovers. */
  deterministicEvidence?: DeterministicDiscoveryEvidence;
  requestCounters?: DiscoveryRequestCounters;
  /** Operational only — never fingerprinted. */
  elapsedMs?: number;
}

export interface ObservationEligibilityWindow {
  fromStartTime: string;
  toStartTime: string;
  sourceCoverageSafetyMarginMs: number;
  contract: typeof CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT;
}

/** Expand export window by margin into half-open [from, to) eligibility bounds. */
export function buildObservationEligibilityWindow(params: {
  exportStartIso: string;
  exportEndIso: string;
  sourceCoverageSafetyMarginMs: number;
}): ObservationEligibilityWindow {
  const margin = Math.max(0, params.sourceCoverageSafetyMarginMs);
  const fromMs = Date.parse(params.exportStartIso) - margin;
  let toMs = Date.parse(params.exportEndIso) + margin;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error("observation_eligibility_window_invalid");
  }
  // Zero-width export window (single UTC instant): include that instant in [from, to).
  if (fromMs === toMs) {
    toMs = fromMs + 1;
  }
  return {
    fromStartTime: new Date(fromMs).toISOString(),
    toStartTime: new Date(toMs).toISOString(),
    sourceCoverageSafetyMarginMs: margin,
    contract: CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
  };
}

export function observationStartInEligibilityWindow(
  startTime: string,
  window: ObservationEligibilityWindow,
): boolean {
  return (
    startTime >= window.fromStartTime && startTime < window.toStartTime
  );
}

/**
 * Map Observations API v2 row into the pure candidate observation shape.
 * Maps `providedModelName` → `model` for existing builder invariants.
 */
export function adaptObservationV2ToCandidateInput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const provided =
    typeof raw.providedModelName === "string" && raw.providedModelName.trim()
      ? raw.providedModelName.trim()
      : null;
  const legacyModel =
    typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
  return {
    ...raw,
    model: provided ?? legacyModel,
    providedModelName: provided ?? legacyModel,
    startTime:
      typeof raw.startTime === "string"
        ? raw.startTime
        : typeof raw.start_time === "string"
          ? raw.start_time
          : raw.startTime,
    endTime:
      typeof raw.endTime === "string"
        ? raw.endTime
        : typeof raw.end_time === "string"
          ? raw.end_time
          : raw.endTime,
  };
}

function extractExistingCursorScores(
  trace: Record<string, unknown>,
): string[] {
  const names = new Set<string>();
  for (const item of asArray(trace.scores)) {
    const rec = asRecord(item);
    const name = rec && typeof rec.name === "string" ? rec.name : null;
    if (name && (CURSOR_USAGE_SCORE_NAMES as readonly string[]).includes(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function canonicalTraceEvidence(trace: Record<string, unknown>): unknown {
  return {
    id: typeof trace.id === "string" ? trace.id : null,
    sessionId: typeof trace.sessionId === "string" ? trace.sessionId : null,
    timestamp: typeof trace.timestamp === "string" ? trace.timestamp : null,
    phase: typeof trace.phase === "string" ? trace.phase : null,
    linearIssueKey: issueKeyFromTrace(trace),
    scoreNames: extractExistingCursorScores(trace),
    metadata: asRecord(trace.metadata) ?? {},
  };
}

function canonicalObservationEvidence(
  obs: Record<string, unknown>,
): unknown {
  return {
    id: typeof obs.id === "string" ? obs.id : null,
    traceId: typeof obs.traceId === "string" ? obs.traceId : null,
    startTime: typeof obs.startTime === "string" ? obs.startTime : null,
    endTime: typeof obs.endTime === "string" ? obs.endTime : null,
    model: rawModelFromObs(obs),
    metadata: asRecord(obs.metadata) ?? {},
    agentId: agentIdFromObs(obs),
  };
}

function stableJsonDigest(value: unknown): string {
  return digestCanonical(value);
}

type DedupeResult<T> = {
  items: T[];
  identicalDuplicates: number;
  divergentDuplicates: number;
};

function dedupeByIdCanonical<T extends { id: string }>(
  items: T[],
  canonical: (item: T) => unknown,
): DedupeResult<T> {
  const byId = new Map<string, { item: T; canon: string }>();
  let identical = 0;
  let divergent = 0;
  for (const item of items) {
    const canon = stableJsonDigest(canonical(item));
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, { item, canon });
      continue;
    }
    if (existing.canon === canon) {
      identical += 1;
      continue;
    }
    divergent += 1;
  }
  const sorted = [...byId.values()]
    .map((v) => v.item)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: sorted,
    identicalDuplicates: identical,
    divergentDuplicates: divergent,
  };
}

export function buildCandidateFromTrace(params: {
  trace: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  namespace: string;
}): UsageCandidate | null {
  const traceId = typeof params.trace.id === "string" ? params.trace.id : null;
  if (!traceId) return null;

  const issueKey = resolveIssueKey({
    trace: params.trace,
    observations: params.observations,
  });
  if (!issueKey) return null;

  const sessionId =
    typeof params.trace.sessionId === "string" ? params.trace.sessionId : null;
  const expectedSessionId = deriveSessionId(params.namespace, issueKey);
  if (!sessionId || sessionId !== expectedSessionId) return null;

  const tracePhase =
    typeof params.trace.phase === "string" ? params.trace.phase : null;

  type AgentWin = {
    phases: Set<AllowedImportPhase>;
    windowStart: string | null;
    windowEnd: string | null;
    harnessRunId: string | null;
    phaseExecutionId: string | null;
    cursorAgentId: string | null;
    model: string | null;
    multiModelFlag: boolean;
  };

  const agentsOnTrace = new Map<string, AgentWin>();
  let effectiveVariant: PricingVariant | null = null;
  const observedByKey = new Map<string, ObservedModelEvidence>();

  for (const obs of params.observations) {
    const obsPhase = resolveObsPhase(obs, tracePhase);
    const aid = agentIdFromObs(obs);
    const meta = asRecord(obs.metadata) ?? {};
    const obsId = typeof obs.id === "string" ? obs.id : null;
    const rawModel = rawModelFromObs(obs);

    if (rawModel && obsId && aid) {
      const normalizedRawModel = normalizeModelRaw(rawModel);
      const canonicalModelId = resolveCanonicalModelId(rawModel);
      const variant = resolveVariantFromMeta(meta) ?? "unknown";
      const key = `${normalizedRawModel}|${variant}|${canonicalModelId ?? "null"}`;
      const existing = observedByKey.get(key);
      if (existing) {
        if (!existing.observationIds.includes(obsId)) {
          existing.observationIds.push(obsId);
          existing.observationIds.sort();
        }
      } else {
        observedByKey.set(key, {
          rawModel,
          normalizedRawModel,
          canonicalModelId,
          variant,
          observationIds: [obsId],
        });
      }
    }

    if (aid && obsPhase) {
      const flagFromMeta = meta[MULTI_MODEL_EXECUTION_PROVEN_FIELD] === true;
      const cur = agentsOnTrace.get(aid) ?? {
        phases: new Set<AllowedImportPhase>(),
        windowStart: null,
        windowEnd: null,
        harnessRunId: null,
        phaseExecutionId: null,
        cursorAgentId: aid,
        model: rawModel,
        multiModelFlag: flagFromMeta,
      };
      cur.phases.add(obsPhase);
      cur.multiModelFlag = cur.multiModelFlag || flagFromMeta;
      const start =
        typeof obs.startTime === "string"
          ? obs.startTime
          : typeof obs.start_time === "string"
            ? obs.start_time
            : null;
      const end =
        typeof obs.endTime === "string"
          ? obs.endTime
          : typeof obs.end_time === "string"
            ? obs.end_time
            : start;
      if (start && (!cur.windowStart || start < cur.windowStart)) {
        cur.windowStart = start;
      }
      if (end && (!cur.windowEnd || end > cur.windowEnd)) {
        cur.windowEnd = end;
      }
      cur.harnessRunId =
        cur.harnessRunId ??
        (typeof obs.harnessRunId === "string" ? obs.harnessRunId : null) ??
        (typeof params.trace.harnessRunId === "string"
          ? params.trace.harnessRunId
          : null);
      cur.phaseExecutionId =
        cur.phaseExecutionId ??
        (typeof obs.phaseExecutionId === "string"
          ? obs.phaseExecutionId
          : null) ??
        (typeof params.trace.phaseExecutionId === "string"
          ? params.trace.phaseExecutionId
          : null);
      if (!cur.model && rawModel) {
        cur.model = rawModel;
      }
      agentsOnTrace.set(aid, cur);
    }
    if (!effectiveVariant) {
      effectiveVariant = resolveVariantFromMeta(meta);
    }
  }

  if (agentsOnTrace.size !== 1) return null;
  const win = [...agentsOnTrace.values()][0]!;
  if (win.phases.size !== 1) return null;

  const phase = [...win.phases][0]!;
  const timestamp =
    typeof params.trace.timestamp === "string"
      ? params.trace.timestamp
      : win.windowEnd;

  const observedModels = [...observedByKey.values()].sort((a, b) =>
    a.normalizedRawModel.localeCompare(b.normalizedRawModel),
  );
  const observedModelIds = [
    ...new Set(
      observedModels
        .map((o) => o.canonicalModelId)
        .filter((id): id is string => id != null),
    ),
  ].sort();
  const multiModelExecutionProven =
    win.multiModelFlag &&
    (observedModelIds.length >= 2 ||
      new Set(observedModels.map((o) => o.normalizedRawModel)).size >= 2);

  return {
    traceId,
    sessionId,
    timestamp,
    cursorAgentId: win.cursorAgentId,
    cursorAgentIdHash: win.cursorAgentId
      ? hashCloudAgentId(win.cursorAgentId)
      : null,
    issueKey,
    phase,
    phaseExecutionId: win.phaseExecutionId,
    harnessRunId: win.harnessRunId,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    model: win.model,
    effectiveVariant,
    existingCursorScoreNames: extractExistingCursorScores(params.trace),
    observedModels,
    observedModelIds,
    multiModelExecutionProven,
    multiModelProofField: MULTI_MODEL_EXECUTION_PROVEN_FIELD,
  };
}

export function candidateSnapshotDigest(candidates: UsageCandidate[]): string {
  const rows = [...candidates]
    .map((c) => ({
      traceId: c.traceId,
      cursorAgentIdHash: c.cursorAgentIdHash,
      issueKey: c.issueKey,
      phase: c.phase,
      model: c.model,
      effectiveVariant: c.effectiveVariant,
      observedModelIds: c.observedModelIds,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
    }))
    .sort((a, b) => a.traceId.localeCompare(b.traceId));
  return digestCanonical(rows);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error(
      typeof reason === "string" ? reason : "langfuse_discovery_cancelled",
    );
  }
}

async function listAllTraces(params: {
  client: LangfuseApiClient;
  fromTimestamp: string;
  toTimestamp: string;
  environment?: string;
  signal?: AbortSignal;
  counters: DiscoveryRequestCounters;
  onProgress?: (p: {
    phase: "trace_retrieval";
    pages: number;
    traces: number;
  }) => void;
}): Promise<{
  traces: Array<Record<string, unknown> & { id: string }>;
  evidence: DatasetRetrievalEvidence;
}> {
  const collected: Array<Record<string, unknown> & { id: string }> = [];
  let page = 1;
  let pagesFetched = 0;
  let complete = false;
  let truncationReason: string | undefined;
  const reqOpts: LangfuseRequestOptions | undefined = params.signal
    ? { abortSignal: params.signal }
    : undefined;

  while (page <= CURSOR_USAGE_TRACE_MAX_PAGES) {
    throwIfAborted(params.signal);
    if (collected.length >= CURSOR_USAGE_TRACE_MAX_RECORDS) {
      truncationReason = "trace_record_cap_reached";
      complete = false;
      break;
    }
    const listParams: Record<string, unknown> = {
      page,
      limit: CURSOR_USAGE_TRACE_PAGE_LIMIT,
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      fields: CURSOR_USAGE_TRACE_LIST_FIELDS,
    };
    if (params.environment?.trim()) {
      listParams.environment = params.environment.trim();
    }
    params.counters.traceListRequestCount += 1;
    const listed = asRecord(
      await params.client.api.trace.list(listParams, reqOpts),
    );
    pagesFetched += 1;
    const data = asArray(listed?.data);
    for (const item of data) {
      const trace = asRecord(item);
      if (!trace || typeof trace.id !== "string") continue;
      collected.push(trace as Record<string, unknown> & { id: string });
    }
    params.onProgress?.({
      phase: "trace_retrieval",
      pages: pagesFetched,
      traces: collected.length,
    });

    const meta = asRecord(listed?.meta);
    const totalPages =
      typeof meta?.totalPages === "number" ? meta.totalPages : null;
    const metaPage = typeof meta?.page === "number" ? meta.page : page;

    if (meta && totalPages != null) {
      if (metaPage >= totalPages || data.length === 0) {
        complete = true;
        break;
      }
      if (data.length >= CURSOR_USAGE_TRACE_PAGE_LIMIT && page >= totalPages) {
        complete = true;
        break;
      }
      page += 1;
      continue;
    }

    if (!meta) {
      if (data.length >= CURSOR_USAGE_TRACE_PAGE_LIMIT) {
        truncationReason = "trace_list_may_be_truncated";
        complete = false;
        break;
      }
      complete = true;
      break;
    }

    if (data.length < CURSOR_USAGE_TRACE_PAGE_LIMIT) {
      complete = true;
      break;
    }

    truncationReason = "trace_list_may_be_truncated";
    complete = false;
    break;
  }

  if (!complete && !truncationReason && page > CURSOR_USAGE_TRACE_MAX_PAGES) {
    truncationReason = "trace_page_cap_reached";
  }

  const deduped = dedupeByIdCanonical(collected, (t) =>
    canonicalTraceEvidence(t),
  );
  if (deduped.divergentDuplicates > 0) {
    return {
      traces: deduped.items,
      evidence: {
        complete: false,
        truncationReason: "trace_duplicate_divergent",
        pagesFetched,
        recordsFetched: collected.length,
        duplicateIdenticalCount: deduped.identicalDuplicates,
        duplicateDivergentCount: deduped.divergentDuplicates,
        pageLimit: CURSOR_USAGE_TRACE_PAGE_LIMIT,
        maxPages: CURSOR_USAGE_TRACE_MAX_PAGES,
        maxRecords: CURSOR_USAGE_TRACE_MAX_RECORDS,
      },
    };
  }

  return {
    traces: deduped.items,
    evidence: {
      complete,
      ...(truncationReason ? { truncationReason } : {}),
      pagesFetched,
      recordsFetched: collected.length,
      duplicateIdenticalCount: deduped.identicalDuplicates,
      duplicateDivergentCount: 0,
      pageLimit: CURSOR_USAGE_TRACE_PAGE_LIMIT,
      maxPages: CURSOR_USAGE_TRACE_MAX_PAGES,
      maxRecords: CURSOR_USAGE_TRACE_MAX_RECORDS,
    },
  };
}

/**
 * Sequential Observations API v2 cursor pagination over the eligibility window.
 * Production path — never uses page/totalPages.
 */
export async function listWindowObservationsV2(params: {
  client: LangfuseApiClient;
  eligibility: ObservationEligibilityWindow;
  environment?: string;
  signal?: AbortSignal;
  counters: DiscoveryRequestCounters;
  onProgress?: (p: {
    phase: "observation_retrieval";
    pages: number;
    observations: number;
  }) => void;
}): Promise<{
  observations: Array<Record<string, unknown> & { id: string }>;
  evidence: DatasetRetrievalEvidence;
  requestSnapshots: Array<Record<string, unknown>>;
}> {
  const collected: Array<Record<string, unknown> & { id: string }> = [];
  const requestSnapshots: Array<Record<string, unknown>> = [];
  let pagesFetched = 0;
  let cursor: string | undefined;
  let complete = false;
  let truncationReason: string | undefined;
  const reqOpts: LangfuseRequestOptions | undefined = params.signal
    ? { abortSignal: params.signal }
    : undefined;

  const baseFilters: Record<string, unknown> = {
    fromStartTime: params.eligibility.fromStartTime,
    toStartTime: params.eligibility.toStartTime,
    limit: CURSOR_USAGE_OBSERVATION_PAGE_LIMIT,
    fields: CURSOR_USAGE_OBSERVATION_V2_FIELDS,
    parseIoAsJson: false,
  };
  if (params.environment?.trim()) {
    baseFilters.environment = params.environment.trim();
  }

  for (;;) {
    throwIfAborted(params.signal);
    if (pagesFetched >= CURSOR_USAGE_OBSERVATION_MAX_PAGES) {
      truncationReason = "observation_page_cap_reached";
      complete = false;
      break;
    }
    if (collected.length >= CURSOR_USAGE_OBSERVATION_MAX_RECORDS) {
      truncationReason = "observation_record_cap_reached";
      complete = false;
      break;
    }

    const request: Record<string, unknown> = { ...baseFilters };
    if (cursor) request.cursor = cursor;
    requestSnapshots.push({ ...request });

    params.counters.observationRequestCount += 1;
    const listed = asRecord(
      await params.client.api.observations.getMany(request, reqOpts),
    );
    pagesFetched += 1;
    const data = asArray(listed?.data ?? listed?.observations);
    for (const item of data) {
      const adapted = adaptObservationV2ToCandidateInput(
        asRecord(item) ?? {},
      );
      if (typeof adapted.id !== "string") continue;
      collected.push(adapted as Record<string, unknown> & { id: string });
    }
    params.onProgress?.({
      phase: "observation_retrieval",
      pages: pagesFetched,
      observations: collected.length,
    });

    const meta = asRecord(listed?.meta);
    const nextCursor =
      meta && typeof meta.cursor === "string" && meta.cursor.length > 0
        ? meta.cursor
        : null;

    // v2 contract: terminal only when meta.cursor absent/null
    if (nextCursor == null) {
      complete = true;
      break;
    }
    cursor = nextCursor;
  }

  const deduped = dedupeByIdCanonical(collected, (o) =>
    canonicalObservationEvidence(o),
  );
  if (deduped.divergentDuplicates > 0) {
    return {
      observations: deduped.items,
      requestSnapshots,
      evidence: {
        complete: false,
        truncationReason: "observation_duplicate_divergent",
        pagesFetched,
        recordsFetched: collected.length,
        duplicateIdenticalCount: deduped.identicalDuplicates,
        duplicateDivergentCount: deduped.divergentDuplicates,
        pageLimit: CURSOR_USAGE_OBSERVATION_PAGE_LIMIT,
        maxPages: CURSOR_USAGE_OBSERVATION_MAX_PAGES,
        maxRecords: CURSOR_USAGE_OBSERVATION_MAX_RECORDS,
      },
    };
  }

  return {
    observations: deduped.items,
    requestSnapshots,
    evidence: {
      complete,
      ...(truncationReason ? { truncationReason } : {}),
      pagesFetched,
      recordsFetched: collected.length,
      duplicateIdenticalCount: deduped.identicalDuplicates,
      duplicateDivergentCount: 0,
      pageLimit: CURSOR_USAGE_OBSERVATION_PAGE_LIMIT,
      maxPages: CURSOR_USAGE_OBSERVATION_MAX_PAGES,
      maxRecords: CURSOR_USAGE_OBSERVATION_MAX_RECORDS,
    },
  };
}

let discoveryInvocationSeq = 0;

/**
 * Window-scoped Observations API v2 discovery (algorithm v2).
 * Production path makes zero per-trace observation-list calls.
 */
export async function discoverUsageCandidates(params: {
  client: LangfuseApiClient;
  namespace: string;
  environment?: string;
  fromTimestamp: string;
  toTimestamp: string;
  sourceCoverageSafetyMarginMs?: number;
  signal?: AbortSignal;
  maxPages?: number;
  maxTraces?: number;
  onProgress?: (p: {
    phase?: string;
    pages: number;
    traces: number;
    observations?: number;
  }) => void;
  discoveryInvocationId?: string;
}): Promise<DiscoverUsageCandidatesResult> {
  const t0 = performance.now();
  discoveryInvocationSeq += 1;
  const requestCounters: DiscoveryRequestCounters = {
    discoveryInvocationId:
      params.discoveryInvocationId ?? `discovery-${discoveryInvocationSeq}`,
    traceListRequestCount: 0,
    observationRequestCount: 0,
    perTraceObservationRequestCount: 0,
  };

  const margin = params.sourceCoverageSafetyMarginMs ?? 0;
  const eligibility = buildObservationEligibilityWindow({
    exportStartIso: params.fromTimestamp,
    exportEndIso: params.toTimestamp,
    sourceCoverageSafetyMarginMs: margin,
  });

  const { traces, evidence: traceEvidence } = await listAllTraces({
    client: params.client,
    fromTimestamp: params.fromTimestamp,
    toTimestamp: params.toTimestamp,
    environment: params.environment,
    signal: params.signal,
    counters: requestCounters,
    onProgress: (p) =>
      params.onProgress?.({
        phase: p.phase,
        pages: p.pages,
        traces: p.traces,
      }),
  });

  const { observations, evidence: obsEvidence } =
    await listWindowObservationsV2({
      client: params.client,
      eligibility,
      environment: params.environment,
      signal: params.signal,
      counters: requestCounters,
      onProgress: (p) =>
        params.onProgress?.({
          phase: p.phase,
          pages: p.pages,
          traces: traces.length,
          observations: p.observations,
        }),
    });

  const traceIdSet = new Set(traces.map((t) => t.id));
  let withoutTraceId = 0;
  const retained: Array<Record<string, unknown> & { id: string }> = [];
  for (const obs of observations) {
    const tid = typeof obs.traceId === "string" ? obs.traceId : null;
    if (!tid) {
      withoutTraceId += 1;
      continue;
    }
    if (!traceIdSet.has(tid)) continue;
    const start =
      typeof obs.startTime === "string" ? obs.startTime : null;
    if (!start || !observationStartInEligibilityWindow(start, eligibility)) {
      continue;
    }
    retained.push(obs);
  }

  retained.sort((a, b) => {
    const ta = typeof a.traceId === "string" ? a.traceId : "";
    const tb = typeof b.traceId === "string" ? b.traceId : "";
    if (ta !== tb) return ta.localeCompare(tb);
    const sa = typeof a.startTime === "string" ? a.startTime : "";
    const sb = typeof b.startTime === "string" ? b.startTime : "";
    if (sa !== sb) return sa.localeCompare(sb);
    return a.id.localeCompare(b.id);
  });

  const byTrace = new Map<string, Array<Record<string, unknown>>>();
  for (const obs of retained) {
    const tid = obs.traceId as string;
    const list = byTrace.get(tid) ?? [];
    list.push(obs);
    byTrace.set(tid, list);
  }

  const candidates: UsageCandidate[] = [];
  const sortedTraces = [...traces].sort((a, b) => a.id.localeCompare(b.id));
  for (const trace of sortedTraces) {
    throwIfAborted(params.signal);
    const obsForTrace = byTrace.get(trace.id) ?? [];
    const candidate = buildCandidateFromTrace({
      trace,
      observations: obsForTrace,
      namespace: params.namespace,
    });
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.traceId.localeCompare(b.traceId));

  const overallComplete = traceEvidence.complete && obsEvidence.complete;
  const truncationReason =
    traceEvidence.truncationReason ?? obsEvidence.truncationReason;

  const hashes = new Set(
    candidates
      .map((c) => c.cursorAgentIdHash)
      .filter((h): h is string => typeof h === "string"),
  );

  const deterministicEvidence: DeterministicDiscoveryEvidence = {
    schemaVersion: DETERMINISTIC_DISCOVERY_EVIDENCE_SCHEMA_VERSION,
    algorithmVersion: CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
    tracePaginationContractVersion: CURSOR_USAGE_TRACE_PAGINATION_CONTRACT_VERSION,
    observationPaginationContractVersion:
      CURSOR_USAGE_OBSERVATION_PAGINATION_CONTRACT_VERSION,
    observationEligibilityContract: CURSOR_USAGE_OBSERVATION_ELIGIBILITY_CONTRACT,
    namespace: params.namespace,
    environmentFilter: params.environment?.trim() || null,
    traceFromTimestamp: params.fromTimestamp,
    traceToTimestamp: params.toTimestamp,
    observationFromStartTime: eligibility.fromStartTime,
    observationToStartTime: eligibility.toStartTime,
    sourceCoverageSafetyMarginMs: margin,
    traceRetrieval: traceEvidence,
    observationRetrieval: obsEvidence,
    tracesDigest: digestCanonical(
      sortedTraces.map((t) => canonicalTraceEvidence(t)),
    ),
    retainedObservationsDigest: digestCanonical(
      retained.map((o) => canonicalObservationEvidence(o)),
    ),
    candidateSnapshotDigest: candidateSnapshotDigest(candidates),
    viableCandidateCount: candidates.length,
    distinctCandidateAgentHashCount: hashes.size,
    observationsFetched: observations.length,
    targetObservationsRetained: retained.length,
    observationsWithoutTraceId: withoutTraceId,
  };

  return {
    candidates,
    retrievalComplete: overallComplete,
    ...(truncationReason ? { truncationReason } : {}),
    pagesFetched: traceEvidence.pagesFetched,
    tracesFetched: traces.length,
    observationPagesFetched: obsEvidence.pagesFetched,
    observationsFetched: observations.length,
    targetObservationsRetained: retained.length,
    algorithmVersion: CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
    deterministicEvidence,
    requestCounters,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/**
 * Test/validation-only per-trace observation oracle (no silent 50-page cutoff).
 * Never used as production fallback.
 */
export async function fetchObservationsForTraceOracle(params: {
  client: LangfuseApiClient;
  traceId: string;
  signal?: AbortSignal;
  maxPages?: number;
  maxRecords?: number;
}): Promise<{
  observations: Array<Record<string, unknown>>;
  complete: boolean;
  pagesFetched: number;
  truncationReason?: string;
  requestCount: number;
}> {
  const maxPages = params.maxPages ?? CURSOR_USAGE_OBSERVATION_MAX_PAGES;
  const maxRecords = params.maxRecords ?? CURSOR_USAGE_OBSERVATION_MAX_RECORDS;
  const observations: Array<Record<string, unknown>> = [];
  let pagesFetched = 0;
  let cursor: string | undefined;
  let requestCount = 0;
  let complete = false;
  let truncationReason: string | undefined;
  const reqOpts: LangfuseRequestOptions | undefined = params.signal
    ? { abortSignal: params.signal }
    : undefined;

  for (;;) {
    throwIfAborted(params.signal);
    if (pagesFetched >= maxPages) {
      truncationReason = "oracle_observation_page_cap_reached";
      break;
    }
    if (observations.length >= maxRecords) {
      truncationReason = "oracle_observation_record_cap_reached";
      break;
    }
    const request: Record<string, unknown> = {
      traceId: params.traceId,
      limit: CURSOR_USAGE_OBSERVATION_PAGE_LIMIT,
      fields: CURSOR_USAGE_OBSERVATION_V2_FIELDS,
      parseIoAsJson: false,
    };
    if (cursor) request.cursor = cursor;
    requestCount += 1;
    const listed = asRecord(
      await params.client.api.observations.getMany(request, reqOpts),
    );
    pagesFetched += 1;
    const data = asArray(listed?.data ?? listed?.observations);
    for (const item of data) {
      const adapted = adaptObservationV2ToCandidateInput(
        asRecord(item) ?? {},
      );
      if (adapted) observations.push(adapted);
    }
    const meta = asRecord(listed?.meta);
    const next =
      meta && typeof meta.cursor === "string" && meta.cursor.length > 0
        ? meta.cursor
        : null;
    if (next == null) {
      complete = true;
      break;
    }
    cursor = next;
  }

  return {
    observations,
    complete,
    pagesFetched,
    ...(truncationReason ? { truncationReason } : {}),
    requestCount,
  };
}

export function filterObservationsByEligibility(
  observations: Array<Record<string, unknown>>,
  eligibility: ObservationEligibilityWindow,
): Array<Record<string, unknown>> {
  return observations.filter((obs) => {
    const start =
      typeof obs.startTime === "string"
        ? obs.startTime
        : typeof obs.start_time === "string"
          ? obs.start_time
          : null;
    return start != null && observationStartInEligibilityWindow(start, eligibility);
  });
}

/**
 * Dual-view oracle helper (test/validation only).
 * Counts viable candidates that depend on agent/phase/issue/model/variant
 * evidence present only outside the production eligibility interval.
 */
export function countOutOfWindowCandidateDependencies(params: {
  namespace: string;
  traces: Array<Record<string, unknown>>;
  completeObservationsByTraceId: Map<string, Array<Record<string, unknown>>>;
  eligibility: ObservationEligibilityWindow;
}): number {
  let count = 0;
  for (const trace of params.traces) {
    const tid = typeof trace.id === "string" ? trace.id : null;
    if (!tid) continue;
    const complete = params.completeObservationsByTraceId.get(tid) ?? [];
    const inWindow = filterObservationsByEligibility(complete, params.eligibility);
    const full = buildCandidateFromTrace({
      trace,
      observations: complete,
      namespace: params.namespace,
    });
    const eligible = buildCandidateFromTrace({
      trace,
      observations: inWindow,
      namespace: params.namespace,
    });
    if (!full) continue;
    if (!eligible) {
      count += 1;
      continue;
    }
    if (candidateSnapshotDigest([full]) !== candidateSnapshotDigest([eligible])) {
      count += 1;
    }
  }
  return count;
}

/** Digest helper for public-safe candidate agent hash sets. */
export function hashPrefix(value: string, n = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, n);
}
