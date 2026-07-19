import type {
  LangfuseInspectGap,
  LangfuseInspectObservation,
  LangfuseInspectScore,
  LangfuseInspectTrace,
} from "./types.js";

function valuesConflict(
  a: unknown,
  b: unknown,
): boolean {
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) > 1e-9;
  }
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

function preferAgreeing<T>(a: T, b: T): T {
  if (a == null || a === "") return b;
  if (b == null || b === "") return a;
  return a;
}

function mergeUsage(
  a: Record<string, number> | null,
  b: Record<string, number> | null,
): { usage: Record<string, number> | null; conflict: boolean } {
  if (!a) return { usage: b, conflict: false };
  if (!b) return { usage: a, conflict: false };
  const usage = { ...a };
  let conflict = false;
  for (const [key, value] of Object.entries(b)) {
    if (usage[key] == null) {
      usage[key] = value;
    } else if (Math.abs(usage[key] - value) > 1e-9) {
      conflict = true;
    }
  }
  return { usage, conflict };
}

function mergeMetadata(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (out[key] == null || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

export function mergeObservations(
  duplicates: LangfuseInspectObservation[],
): { observation: LangfuseInspectObservation; conflict: boolean } {
  if (duplicates.length === 0) {
    throw new Error("mergeObservations requires at least one observation");
  }
  let merged = { ...duplicates[0], metadata: { ...duplicates[0].metadata } };
  let conflict = false;

  for (const next of duplicates.slice(1)) {
    const identityFields: Array<keyof LangfuseInspectObservation> = [
      "model",
      "phase",
      "phaseExecutionId",
      "harnessRunId",
      "cursorRunId",
      "costUsd",
      "costSource",
      "pricingRegistryVersion",
      "linearIssueKey",
      "type",
    ];
    for (const field of identityFields) {
      if (valuesConflict(merged[field], next[field])) {
        conflict = true;
      }
    }
    const usageMerge = mergeUsage(merged.usage, next.usage);
    if (usageMerge.conflict) conflict = true;

    merged = {
      ...merged,
      name: preferAgreeing(merged.name, next.name),
      type: preferAgreeing(merged.type, next.type),
      startTime: preferAgreeing(merged.startTime, next.startTime),
      endTime: preferAgreeing(merged.endTime, next.endTime),
      model: preferAgreeing(merged.model, next.model),
      hasInput: merged.hasInput || next.hasInput,
      hasOutput: merged.hasOutput || next.hasOutput,
      inputByteCount: preferAgreeing(merged.inputByteCount, next.inputByteCount),
      outputByteCount: preferAgreeing(
        merged.outputByteCount,
        next.outputByteCount,
      ),
      inputSha256: preferAgreeing(merged.inputSha256, next.inputSha256),
      outputSha256: preferAgreeing(merged.outputSha256, next.outputSha256),
      usage: usageMerge.usage,
      costUsd: preferAgreeing(merged.costUsd, next.costUsd),
      costSource: preferAgreeing(merged.costSource, next.costSource),
      costUnavailableReason: preferAgreeing(
        merged.costUnavailableReason,
        next.costUnavailableReason,
      ),
      pricingRegistryVersion: preferAgreeing(
        merged.pricingRegistryVersion,
        next.pricingRegistryVersion,
      ),
      promptName: preferAgreeing(merged.promptName, next.promptName),
      promptContractVersion: preferAgreeing(
        merged.promptContractVersion,
        next.promptContractVersion,
      ),
      skillIds: [...new Set([...merged.skillIds, ...next.skillIds])],
      skillProvenanceStatus: preferAgreeing(
        merged.skillProvenanceStatus,
        next.skillProvenanceStatus,
      ),
      toolCount: Math.max(merged.toolCount, next.toolCount),
      agentId: preferAgreeing(merged.agentId, next.agentId),
      cursorRunId: preferAgreeing(merged.cursorRunId, next.cursorRunId),
      linearIssueKey: preferAgreeing(merged.linearIssueKey, next.linearIssueKey),
      phase: preferAgreeing(merged.phase, next.phase),
      phaseExecutionId: preferAgreeing(
        merged.phaseExecutionId,
        next.phaseExecutionId,
      ),
      harnessRunId: preferAgreeing(merged.harnessRunId, next.harnessRunId),
      revisionCycleIndex: preferAgreeing(
        merged.revisionCycleIndex,
        next.revisionCycleIndex,
      ),
      metadata: mergeMetadata(merged.metadata, next.metadata),
    };
  }

  return { observation: merged, conflict };
}

export function mergeScores(
  duplicates: LangfuseInspectScore[],
): { score: LangfuseInspectScore; conflict: boolean } {
  if (duplicates.length === 0) {
    throw new Error("mergeScores requires at least one score");
  }
  let merged = { ...duplicates[0] };
  let conflict = false;
  for (const next of duplicates.slice(1)) {
    if (
      valuesConflict(merged.value, next.value) ||
      valuesConflict(merged.traceId, next.traceId) ||
      valuesConflict(merged.sessionId, next.sessionId) ||
      valuesConflict(merged.observationId, next.observationId) ||
      valuesConflict(merged.name, next.name)
    ) {
      conflict = true;
    }
    merged = {
      ...merged,
      name: preferAgreeing(merged.name, next.name),
      traceId: preferAgreeing(merged.traceId, next.traceId),
      sessionId: preferAgreeing(merged.sessionId, next.sessionId),
      observationId: preferAgreeing(merged.observationId, next.observationId),
      dataType: preferAgreeing(merged.dataType, next.dataType),
      value: preferAgreeing(merged.value, next.value),
      timestamp: preferAgreeing(merged.timestamp, next.timestamp),
    };
  }
  return { score: merged, conflict };
}

export function mergeTraces(
  duplicates: LangfuseInspectTrace[],
): { trace: LangfuseInspectTrace; conflict: boolean } {
  if (duplicates.length === 0) {
    throw new Error("mergeTraces requires at least one trace");
  }
  let merged = {
    ...duplicates[0],
    observations: [...duplicates[0].observations],
    scores: [...duplicates[0].scores],
  };
  let conflict = false;

  for (const next of duplicates.slice(1)) {
    for (const field of [
      "phase",
      "sessionId",
      "phaseExecutionId",
      "harnessRunId",
      "linearIssueKey",
    ] as const) {
      if (valuesConflict(merged[field], next[field])) {
        conflict = true;
      }
    }
    merged = {
      ...merged,
      name: preferAgreeing(merged.name, next.name),
      sessionId: preferAgreeing(merged.sessionId, next.sessionId),
      timestamp: preferAgreeing(merged.timestamp, next.timestamp),
      linearIssueKey: preferAgreeing(merged.linearIssueKey, next.linearIssueKey),
      phase: preferAgreeing(merged.phase, next.phase),
      phaseExecutionId: preferAgreeing(
        merged.phaseExecutionId,
        next.phaseExecutionId,
      ),
      harnessRunId: preferAgreeing(merged.harnessRunId, next.harnessRunId),
      revisionCycleIndex: preferAgreeing(
        merged.revisionCycleIndex,
        next.revisionCycleIndex,
      ),
      hasInput: merged.hasInput || next.hasInput,
      hasOutput: merged.hasOutput || next.hasOutput,
      issueIdentityMissing:
        merged.issueIdentityMissing && next.issueIdentityMissing,
      observations: [...merged.observations, ...next.observations],
      scores: [...merged.scores, ...next.scores],
    };
  }

  // Merge nested observations/scores by id after combining sets
  const obsById = new Map<string, LangfuseInspectObservation[]>();
  for (const obs of merged.observations) {
    const list = obsById.get(obs.id) ?? [];
    list.push(obs);
    obsById.set(obs.id, list);
  }
  const observations: LangfuseInspectObservation[] = [];
  for (const group of obsById.values()) {
    const result = mergeObservations(group);
    if (result.conflict) conflict = true;
    observations.push(result.observation);
  }

  const scoreById = new Map<string, LangfuseInspectScore[]>();
  for (const score of merged.scores) {
    const list = scoreById.get(score.id) ?? [];
    list.push(score);
    scoreById.set(score.id, list);
  }
  const scores: LangfuseInspectScore[] = [];
  for (const group of scoreById.values()) {
    const result = mergeScores(group);
    if (result.conflict) conflict = true;
    scores.push(result.score);
  }

  return {
    trace: { ...merged, observations, scores },
    conflict,
  };
}

export function dedupeGaps(gaps: LangfuseInspectGap[]): LangfuseInspectGap[] {
  const seen = new Set<string>();
  const out: LangfuseInspectGap[] = [];
  for (const gap of gaps) {
    const key = [
      gap.code,
      gap.traceId ?? "",
      gap.observationId ?? "",
      gap.reasonCode ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

export function mergeSessionBundle(params: {
  traces: LangfuseInspectTrace[];
  scores: LangfuseInspectScore[];
}): {
  traces: LangfuseInspectTrace[];
  scores: LangfuseInspectScore[];
  gaps: LangfuseInspectGap[];
} {
  const gaps: LangfuseInspectGap[] = [];

  const tracesById = new Map<string, LangfuseInspectTrace[]>();
  for (const trace of params.traces) {
    if (!trace.id) continue;
    const list = tracesById.get(trace.id) ?? [];
    list.push(trace);
    tracesById.set(trace.id, list);
  }

  const traces: LangfuseInspectTrace[] = [];
  for (const [traceId, group] of tracesById) {
    const result = mergeTraces(group);
    traces.push(result.trace);
    if (result.conflict || group.length > 1) {
      // Only emit conflict gap when values actually conflict
      if (result.conflict) {
        gaps.push({
          code: "duplicate_trace_identity_conflict",
          severity: "error",
          message: `Trace ${traceId} has conflicting phase, session, or correlation identities across duplicates`,
          traceId,
          reasonCode: "identity_conflict",
        });
      }
    }

    // Observation-level conflicts inside the merged trace
    const obsGroups = new Map<string, number>();
    for (const obs of group.flatMap((t) => t.observations)) {
      obsGroups.set(obs.id, (obsGroups.get(obs.id) ?? 0) + 1);
    }
  }

  // Re-check observation conflicts across pre-merge duplicates for gap emission
  const allObs = params.traces.flatMap((t) =>
    t.observations.map((o) => ({ traceId: t.id, obs: o })),
  );
  const obsById = new Map<string, typeof allObs>();
  for (const entry of allObs) {
    const list = obsById.get(entry.obs.id) ?? [];
    list.push(entry);
    obsById.set(entry.obs.id, list);
  }
  for (const [obsId, group] of obsById) {
    if (group.length < 2) continue;
    const result = mergeObservations(group.map((g) => g.obs));
    if (result.conflict) {
      gaps.push({
        code: "duplicate_observation_identity_conflict",
        severity: "error",
        message: `Observation ${obsId} has conflicting model, phase, usage, cost, or pricing fields across duplicates`,
        traceId: group[0]?.traceId,
        observationId: obsId,
        reasonCode: "identity_conflict",
      });
    }
  }

  const scoresById = new Map<string, LangfuseInspectScore[]>();
  for (const score of params.scores) {
    if (!score.id) continue;
    const list = scoresById.get(score.id) ?? [];
    list.push(score);
    scoresById.set(score.id, list);
  }
  const scores: LangfuseInspectScore[] = [];
  for (const [scoreId, group] of scoresById) {
    const result = mergeScores(group);
    scores.push(result.score);
    if (result.conflict) {
      gaps.push({
        code: "duplicate_score_identity_conflict",
        severity: "error",
        message: `Score ${scoreId} has conflicting value or correlation fields across duplicates`,
        traceId: result.score.traceId ?? undefined,
        reasonCode: "identity_conflict",
      });
    }
  }

  // Attach session-level scores onto traces after score merge
  const scoresByTrace = new Map<string, LangfuseInspectScore[]>();
  for (const score of scores) {
    if (!score.traceId) continue;
    const list = scoresByTrace.get(score.traceId) ?? [];
    list.push(score);
    scoresByTrace.set(score.traceId, list);
  }
  for (const trace of traces) {
    const fromSession = scoresByTrace.get(trace.id) ?? [];
    const byId = new Map<string, LangfuseInspectScore>();
    for (const s of [...trace.scores, ...fromSession]) {
      byId.set(s.id, s);
    }
    trace.scores = [...byId.values()];
  }

  return { traces, scores, gaps };
}
