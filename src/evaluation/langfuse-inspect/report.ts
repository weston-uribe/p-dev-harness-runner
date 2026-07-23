import {
  DEFAULT_EXPECTED_INSPECT_PHASES,
  extractIssueKeyFromDisplayName,
  isPlannerAgentDisplayName,
  isPlanningTraceDisplayName,
  isPlanReviewerAgentDisplayName,
  isPlanReviewTraceDisplayName,
  sessionDisplayName,
} from "../naming.js";
import {
  isEvaluationPhase,
  phaseInvokesAgent,
  type EvaluationPhase,
} from "../phases.js";
import {
  estimateCostUsd,
  PRICING_REGISTRY_VERSION,
  resolvePricingVariant,
  type PricingVariant,
} from "../telemetry/pricing-registry.js";
import {
  contentPresence,
  metadataNumber,
  metadataString,
} from "./client.js";
import { classifyGenerationCandidates } from "./generations.js";
import { dedupeGaps, mergeSessionBundle } from "./merge.js";
import type {
  LangfuseInspectGap,
  LangfuseInspectObservation,
  LangfuseInspectReport,
  LangfuseInspectScore,
  LangfuseInspectTrace,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeMetadata(
  value: unknown,
): Record<string, unknown> | null {
  return asRecord(value);
}

function mapScore(raw: Record<string, unknown>): LangfuseInspectScore {
  return {
    id: typeof raw.id === "string" ? raw.id : String(raw.id ?? ""),
    name: typeof raw.name === "string" ? raw.name : "unknown",
    traceId: typeof raw.traceId === "string" ? raw.traceId : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    observationId:
      typeof raw.observationId === "string" ? raw.observationId : null,
    dataType: typeof raw.dataType === "string" ? raw.dataType : null,
    value: raw.value ?? raw.stringValue ?? raw.numberValue ?? null,
    timestamp:
      typeof raw.timestamp === "string"
        ? raw.timestamp
        : raw.createdAt
          ? String(raw.createdAt)
          : null,
  };
}

function mapObservation(
  raw: Record<string, unknown>,
): LangfuseInspectObservation {
  const metadata = normalizeMetadata(raw.metadata) ?? {};
  const inputInfo = contentPresence(raw.input);
  const outputInfo = contentPresence(raw.output);
  const usageRaw = asRecord(raw.usageDetails) ?? asRecord(raw.usage);
  const usage: Record<string, number> | null = usageRaw
    ? Object.fromEntries(
        Object.entries(usageRaw).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : null;
  const costDetails = asRecord(raw.costDetails);
  const totalCost =
    typeof costDetails?.total === "number"
      ? costDetails.total
      : typeof raw.calculatedTotalCost === "number"
        ? raw.calculatedTotalCost
        : metadataNumber(metadata, "costUsd");

  const skillIds: string[] = [];
  const skillsUsed = metadata.skillsUsed;
  if (Array.isArray(skillsUsed)) {
    for (const s of skillsUsed) {
      if (typeof s === "string") skillIds.push(s);
      else {
        const rec = asRecord(s);
        if (rec && typeof rec.skillId === "string") skillIds.push(rec.skillId);
      }
    }
  }

  const name = typeof raw.name === "string" ? raw.name : null;
  const linearIssueKey =
    metadataString(metadata, "linearIssueKey") ??
    metadataString(metadata, "issueKey") ??
    extractIssueKeyFromDisplayName(name);

  return {
    id: typeof raw.id === "string" ? raw.id : String(raw.id ?? ""),
    name,
    type: typeof raw.type === "string" ? raw.type : null,
    startTime:
      typeof raw.startTime === "string"
        ? raw.startTime
        : raw.startTime
          ? String(raw.startTime)
          : null,
    endTime:
      typeof raw.endTime === "string"
        ? raw.endTime
        : raw.endTime
          ? String(raw.endTime)
          : null,
    model:
      typeof raw.model === "string"
        ? raw.model
        : metadataString(metadata, "modelId"),
    hasInput: inputInfo.has,
    hasOutput: outputInfo.has,
    inputByteCount: inputInfo.byteCount,
    outputByteCount: outputInfo.byteCount,
    inputSha256: inputInfo.sha256,
    outputSha256: outputInfo.sha256,
    usage,
    costUsd: totalCost,
    costSource: metadataString(metadata, "costSource"),
    costUnavailableReason: metadataString(metadata, "costUnavailableReason"),
    pricingRegistryVersion: metadataString(metadata, "pricingRegistryVersion"),
    promptName: metadataString(metadata, "promptName"),
    promptContractVersion: metadataString(metadata, "promptContractVersion"),
    skillIds,
    skillProvenanceStatus: metadataString(metadata, "skillProvenanceStatus"),
    toolCount: asArray(raw.observations).length,
    agentId:
      metadataString(metadata, "cursorAgentId") ??
      metadataString(metadata, "agentId"),
    cursorRunId: metadataString(metadata, "cursorRunId"),
    linearIssueKey,
    phase: metadataString(metadata, "phase"),
    phaseExecutionId: metadataString(metadata, "phaseExecutionId"),
    harnessRunId:
      metadataString(metadata, "harnessRunId") ??
      metadataString(metadata, "pDevRunId"),
    revisionCycleIndex: metadataNumber(metadata, "revisionCycleIndex"),
    metadata,
  };
}

function readUsageToken(
  usage: Record<string, number> | null,
  keys: string[],
): number | null {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readGenerationInputTokens(
  obs: LangfuseInspectObservation,
): number | null {
  return (
    readUsageToken(obs.usage, ["input", "inputTokens", "promptTokens"]) ??
    metadataNumber(obs.metadata, "cursorUsageInputTokens")
  );
}

function readGenerationOutputTokens(
  obs: LangfuseInspectObservation,
): number | null {
  return (
    readUsageToken(obs.usage, ["output", "outputTokens", "completionTokens"]) ??
    metadataNumber(obs.metadata, "cursorUsageOutputTokens")
  );
}

function readModelParams(
  obs: LangfuseInspectObservation,
): ReadonlyArray<{ id: string; value: string }> | null {
  const raw = obs.metadata.modelParams ?? obs.metadata.effectiveRequestedParams;
  if (!Array.isArray(raw)) return null;
  const params = raw
    .map((entry) => {
      const rec = asRecord(entry);
      if (!rec || typeof rec.id !== "string" || typeof rec.value !== "string") {
        return null;
      }
      return { id: rec.id, value: rec.value };
    })
    .filter((entry): entry is { id: string; value: string } => entry != null);
  return params.length > 0 ? params : null;
}

function readEffectiveVariant(
  obs: LangfuseInspectObservation,
): PricingVariant | null {
  const fromMetadata = metadataString(obs.metadata, "effectiveVariant");
  if (fromMetadata === "fast" || fromMetadata === "standard") {
    return fromMetadata;
  }
  if (obs.metadata.fast === true) return "fast";
  if (obs.metadata.fast === false) return "standard";
  const params = readModelParams(obs);
  if (params) {
    return resolvePricingVariant(params);
  }
  return null;
}

function readProviderCostUsd(obs: LangfuseInspectObservation): number | null {
  const fromMetadata = metadataNumber(obs.metadata, "providerReportedCostUsd");
  if (fromMetadata != null) return fromMetadata;
  if (obs.costSource === "provider" && typeof obs.costUsd === "number") {
    return obs.costUsd;
  }
  return null;
}

function readEstimatedCostUsd(obs: LangfuseInspectObservation): number | null {
  const fromMetadata = metadataNumber(obs.metadata, "estimatedCostUsd");
  if (fromMetadata != null) return fromMetadata;
  if (obs.costSource === "pricing_registry" && typeof obs.costUsd === "number") {
    return obs.costUsd;
  }
  return null;
}

export function generationCostIncompleteReason(
  obs: LangfuseInspectObservation,
): string | null {
  if (readGenerationInputTokens(obs) == null) {
    return "missing_input_token_usage";
  }
  if (readGenerationOutputTokens(obs) == null) {
    return "missing_output_token_usage";
  }
  if (!obs.model?.trim()) {
    return "missing_effective_model";
  }
  if (!readEffectiveVariant(obs)) {
    return "missing_effective_variant";
  }

  const providerUsd = readProviderCostUsd(obs);
  const estimatedUsd = readEstimatedCostUsd(obs);
  const hasProvider = providerUsd != null;
  const hasEstimated = estimatedUsd != null;

  if (!hasProvider && !hasEstimated) {
    return "missing_cost_source";
  }
  if (hasProvider && hasEstimated) {
    return "dual_authoritative_cost_sources";
  }

  const costSource = obs.costSource?.trim();
  if (costSource === "provider") {
    if (!hasProvider) {
      return "cost_source_contradicts_fields";
    }
    if (typeof obs.costUsd === "number" && Math.abs(obs.costUsd - providerUsd) > 1e-9) {
      return "cost_source_contradicts_fields";
    }
    return null;
  }

  if (costSource === "pricing_registry") {
    if (!hasEstimated) {
      return "cost_source_contradicts_fields";
    }
    if (!obs.pricingRegistryVersion?.trim()) {
      return "missing_pricing_registry_version";
    }
    if (obs.pricingRegistryVersion !== PRICING_REGISTRY_VERSION) {
      return "stale_pricing_registry_version";
    }
    const variant = readEffectiveVariant(obs);
    const inputTokens = readGenerationInputTokens(obs) ?? 0;
    const outputTokens = readGenerationOutputTokens(obs) ?? 0;
    const expected = estimateCostUsd({
      modelId: obs.model,
      modelParams: readModelParams(obs),
      inputTokens,
      outputTokens,
    });
    if (!expected) {
      return "missing_pricing_registry_estimate";
    }
    if (variant && expected.variant !== variant) {
      return "variant_pricing_mismatch";
    }
    if (
      typeof obs.costUsd === "number" &&
      Math.abs(obs.costUsd - expected.estimatedCostUsd) > 1e-6
    ) {
      return "variant_pricing_mismatch";
    }
    if (typeof obs.costUsd === "number" && Math.abs(obs.costUsd - estimatedUsd!) > 1e-9) {
      return "cost_source_contradicts_fields";
    }
    return null;
  }

  if (costSource === "unavailable" || !costSource) {
    return "missing_cost_source";
  }

  return "cost_source_contradicts_fields";
}

function generationCostComplete(obs: LangfuseInspectObservation): boolean {
  return generationCostIncompleteReason(obs) == null;
}

function observationClaimsSkillUsage(obs: LangfuseInspectObservation): boolean {
  if (obs.skillIds.length > 0) return true;
  if (obs.skillProvenanceStatus === "present") return true;
  const inclusion = obs.metadata.inclusionMethod;
  if (inclusion === "rendered_into_prompt") return true;
  const skillsUsed = obs.metadata.skillsUsed;
  if (Array.isArray(skillsUsed) && skillsUsed.length > 0) return true;
  return false;
}

export function collectPromptSkillInspectGaps(
  obs: LangfuseInspectObservation,
  traceId: string,
): LangfuseInspectGap[] {
  const gaps: LangfuseInspectGap[] = [];
  if (
    obs.type !== "GENERATION" &&
    obs.type !== "generation" &&
    !obs.name?.includes("Cursor run")
  ) {
    return gaps;
  }

  const hasPromptMeta =
    Boolean(obs.promptName) ||
    Boolean(obs.metadata.promptProvider) ||
    Boolean(obs.metadata.promptSource);

  if (hasPromptMeta && !obs.promptName) {
    gaps.push({
      code: "missing_prompt_source",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} missing promptName`,
      traceId: traceId || undefined,
      observationId: obs.id,
      reasonCode: "missing_prompt_source",
    });
  }
  if (hasPromptMeta && !obs.promptContractVersion) {
    gaps.push({
      code: "missing_prompt_contract",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} missing promptContractVersion`,
      traceId: traceId || undefined,
      observationId: obs.id,
      reasonCode: "missing_prompt_contract",
    });
  }

  const source = obs.metadata.promptSource;
  const linked = obs.metadata.langfusePromptLinked === true;
  const hasLinkObject = obs.metadata.langfusePrompt != null;
  if (source === "langfuse" && (!linked || !hasLinkObject)) {
    gaps.push({
      code: "claimed_remote_prompt_without_link",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} claims langfuse prompt source without a real prompt link`,
      traceId: traceId || undefined,
      observationId: obs.id,
      reasonCode: "claimed_remote_prompt_without_link",
    });
  }
  if (source === "local" && (linked || hasLinkObject)) {
    gaps.push({
      code: "invalid_fallback_state",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} has local prompt source but claims a Langfuse prompt link`,
      traceId: traceId || undefined,
      observationId: obs.id,
      reasonCode: "invalid_fallback_state",
    });
  }

  const skillsUsed = obs.metadata.skillsUsed;
  if (Array.isArray(skillsUsed)) {
    const seen = new Set<string>();
    for (const raw of skillsUsed) {
      const rec =
        raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : null;
      const skillId = typeof rec?.skillId === "string" ? rec.skillId : null;
      if (skillId && seen.has(skillId)) {
        gaps.push({
          code: "duplicate_skill_injection",
          severity: "error",
          message: `Generation ${obs.name ?? obs.id} lists skill ${skillId} more than once`,
          traceId: traceId || undefined,
          observationId: obs.id,
          reasonCode: skillId,
        });
      }
      if (skillId) seen.add(skillId);

      if (rec?.discovered === true || rec?.invoked === true) {
        const mode = rec.inclusionMethod ?? obs.metadata.skillInvocationMode;
        if (mode !== "provider_native") {
          gaps.push({
            code: "false_native_skill_claim",
            severity: "error",
            message: `Generation ${obs.name ?? obs.id} claims skill discovered/invoked without provider_native evidence`,
            traceId: traceId || undefined,
            observationId: obs.id,
            reasonCode: "false_native_skill_claim",
          });
        }
      }
    }
  }

  return gaps;
}

function resolveExpectedPhases(params: {
  expectedPhases?: string[];
}): string[] {
  if (params.expectedPhases && params.expectedPhases.length > 0) {
    return [...params.expectedPhases];
  }
  const fromEnv = process.env.P_DEV_LANGFUSE_EXPECTED_PHASES?.trim();
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_EXPECTED_INSPECT_PHASES];
}

function buildRawTraces(params: {
  issueKey: string;
  sessionId: string;
  traces: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
}): {
  traces: LangfuseInspectTrace[];
  scores: LangfuseInspectScore[];
  gaps: LangfuseInspectGap[];
} {
  const issueKey = params.issueKey;
  const obsByTrace = new Map<string, LangfuseInspectObservation[]>();
  for (const raw of params.observations) {
    const obs = mapObservation(raw);
    const traceId =
      typeof raw.traceId === "string"
        ? raw.traceId
        : typeof asRecord(raw)?.traceId === "string"
          ? String(raw.traceId)
          : null;
    if (!traceId) continue;
    const list = obsByTrace.get(traceId) ?? [];
    list.push(obs);
    obsByTrace.set(traceId, list);
  }

  const allScores = params.scores.map(mapScore);
  const gaps: LangfuseInspectGap[] = [];
  const traces: LangfuseInspectTrace[] = [];

  for (const raw of params.traces) {
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : null;
    const metadata = normalizeMetadata(raw.metadata) ?? {};
    const linearIssueKey =
      metadataString(metadata, "linearIssueKey") ??
      metadataString(metadata, "issueKey") ??
      extractIssueKeyFromDisplayName(name);
    const usesHumanReadableName = Boolean(
      name && extractIssueKeyFromDisplayName(name),
    );
    const isLegacyMachineName = Boolean(
      name && /^p-dev\./.test(name) && !usesHumanReadableName,
    );
    const issueIdentityMissing = !linearIssueKey;
    if (issueIdentityMissing) {
      gaps.push({
        code: "missing_visible_issue_key",
        severity: usesHumanReadableName || !isLegacyMachineName ? "error" : "warning",
        message: `Trace ${id || name || "unknown"} lacks visible Linear issue identity`,
        traceId: id || undefined,
        reasonCode: "missing_visible_issue_key",
      });
    } else if (linearIssueKey.toUpperCase() !== issueKey.toUpperCase()) {
      gaps.push({
        code: "issue_identity_conflict",
        severity: "error",
        message: `Trace ${id} identity ${linearIssueKey} conflicts with requested ${issueKey}`,
        traceId: id || undefined,
        reasonCode: "issue_identity_conflict",
      });
    }

    const observations = [...(obsByTrace.get(id) ?? [])];
    for (const nested of asArray(raw.observations)) {
      const rec = asRecord(nested);
      if (!rec) continue;
      observations.push(mapObservation(rec));
    }

    const inputInfo = contentPresence(raw.input);
    const outputInfo = contentPresence(raw.output);

    traces.push({
      id,
      name,
      sessionId:
        typeof raw.sessionId === "string"
          ? raw.sessionId
          : params.sessionId,
      timestamp:
        typeof raw.timestamp === "string"
          ? raw.timestamp
          : raw.timestamp
            ? String(raw.timestamp)
            : null,
      linearIssueKey,
      phase: metadataString(metadata, "phase"),
      phaseExecutionId: metadataString(metadata, "phaseExecutionId"),
      harnessRunId:
        metadataString(metadata, "harnessRunId") ??
        metadataString(metadata, "pDevRunId"),
      revisionCycleIndex: metadataNumber(metadata, "revisionCycleIndex"),
      hasInput: inputInfo.has,
      hasOutput: outputInfo.has,
      observations,
      scores: [],
      issueIdentityMissing,
    });
  }

  return { traces, scores: allScores, gaps };
}

const CSV_SCORE_NAMES = [
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
  "cursor_list_price_equivalent_complete",
  "cursor_provider_actual_cost_complete",
  "cursor_exact_cost_complete",
  "cursor_generation_native_usage_complete",
] as const;

function scoreValueEquals(score: LangfuseInspectScore, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (score.value === expected) return true;
  if (expected === true && (score.value === 1 || score.value === "1")) return true;
  if (expected === false && (score.value === 0 || score.value === "0")) return true;
  return false;
}

function numericScoreValue(score: LangfuseInspectScore | undefined): number | null {
  if (!score) return null;
  if (typeof score.value === "number" && Number.isFinite(score.value)) {
    return score.value;
  }
  if (typeof score.value === "string" && /^-?\d+(\.\d+)?$/.test(score.value)) {
    return Number(score.value);
  }
  return null;
}

function resolveCanonicalCsvPhaseTrace(
  traces: LangfuseInspectTrace[],
  phase: EvaluationPhase,
): { trace: LangfuseInspectTrace | null; reason: string | null } {
  const candidates = traces.filter((t) => t.phase === phase);
  if (candidates.length === 0) {
    return { trace: null, reason: `missing_csv_score_trace:${phase}` };
  }
  if (candidates.length > 1) {
    return { trace: null, reason: `ambiguous_csv_score_trace:${phase}` };
  }
  return { trace: candidates[0]!, reason: null };
}

/**
 * Per-required-phase CSV score acceptance. One complete phase cannot hide another.
 * Expected phases may be any agent-invoking phase; completeness is from the
 * selected source scope (not a universal workflow phase list).
 */
export function evaluateCursorCsvScoreAcceptance(params: {
  traces: LangfuseInspectTrace[];
  allScores: LangfuseInspectScore[];
  expectedPhases: string[];
  gaps: LangfuseInspectGap[];
}): {
  tokenAcceptance: boolean;
  costProxyAvailable: boolean;
  nativeUsageComplete: boolean;
} {
  const requiredPhases = params.expectedPhases.filter(
    (p): p is EvaluationPhase =>
      isEvaluationPhase(p) && phaseInvokesAgent(p),
  );
  if (requiredPhases.length === 0) {
    return {
      tokenAcceptance: false,
      costProxyAvailable: false,
      nativeUsageComplete: false,
    };
  }

  let allTokenOk = true;
  let allProxyOk = true;
  let anyNativeComplete = false;

  for (const phase of requiredPhases) {
    const { trace, reason } = resolveCanonicalCsvPhaseTrace(
      params.traces,
      phase,
    );
    if (!trace) {
      if (reason) {
        params.gaps.push({
          code: reason.startsWith("missing_")
            ? "missing_csv_score_trace"
            : "ambiguous_csv_score_trace",
          severity: "warning",
          message: reason,
          reasonCode: reason,
        });
      }
      allTokenOk = false;
      allProxyOk = false;
      continue;
    }

    const phaseScores = params.allScores.filter((s) => s.traceId === trace.id);
    const scoresOnOtherPhaseTraces = params.allScores.filter((s) => {
      if (!s.name?.startsWith("cursor_")) return false;
      if (s.traceId === trace.id) return false;
      const other = params.traces.find((t) => t.id === s.traceId);
      return other?.phase === phase;
    });
    if (scoresOnOtherPhaseTraces.length > 0) {
      params.gaps.push({
        code: "csv_scores_split_across_traces",
        severity: "warning",
        message: `csv_scores_split_across_traces:${phase}`,
        reasonCode: `csv_scores_split_across_traces:${phase}`,
      });
      allTokenOk = false;
      allProxyOk = false;
      continue;
    }

    const byName = new Map<string, LangfuseInspectScore[]>();
    for (const s of phaseScores) {
      if (!s.name) continue;
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }

    const exactlyOne = (name: string): LangfuseInspectScore | null => {
      const list = byName.get(name) ?? [];
      return list.length === 1 ? list[0]! : null;
    };

    let phaseTokenOk = true;
    for (const name of CSV_SCORE_NAMES) {
      if (!exactlyOne(name)) {
        phaseTokenOk = false;
        break;
      }
    }

    const input = numericScoreValue(exactlyOne("cursor_input_tokens") ?? undefined);
    const cacheRead = numericScoreValue(
      exactlyOne("cursor_cache_read_tokens") ?? undefined,
    );
    const cacheWrite = numericScoreValue(
      exactlyOne("cursor_cache_write_tokens") ?? undefined,
    );
    const output = numericScoreValue(
      exactlyOne("cursor_output_tokens") ?? undefined,
    );
    const total = numericScoreValue(exactlyOne("cursor_total_tokens") ?? undefined);
    if (
      input == null ||
      cacheRead == null ||
      cacheWrite == null ||
      output == null ||
      total == null ||
      total !== input + cacheRead + cacheWrite + output
    ) {
      phaseTokenOk = false;
    }

    const tokenComplete = exactlyOne("cursor_token_usage_complete");
    const sourceScope = exactlyOne("cursor_source_scope_complete");
    const exactCost = exactlyOne("cursor_exact_cost_complete");
    const nativeUsage = exactlyOne("cursor_generation_native_usage_complete");
    if (
      !tokenComplete ||
      !scoreValueEquals(tokenComplete, true) ||
      !sourceScope ||
      !scoreValueEquals(sourceScope, true) ||
      !exactCost ||
      !scoreValueEquals(exactCost, false) ||
      !nativeUsage ||
      !scoreValueEquals(nativeUsage, false)
    ) {
      phaseTokenOk = false;
    }

    const proxyAvail = exactlyOne("cursor_cost_proxy_available");
    const known = exactlyOne("cursor_known_noncache_cost_usd");
    const broad = exactlyOne("cursor_all_input_at_list_rate_usd");
    const phaseProxyOk =
      proxyAvail != null &&
      scoreValueEquals(proxyAvail, true) &&
      known != null &&
      broad != null &&
      numericScoreValue(known) != null &&
      numericScoreValue(broad) != null;

    if (nativeUsage && scoreValueEquals(nativeUsage, true)) {
      anyNativeComplete = true;
    }

    if (!phaseTokenOk) allTokenOk = false;
    if (!phaseProxyOk) allProxyOk = false;
  }

  return {
    tokenAcceptance: allTokenOk,
    costProxyAvailable: allProxyOk,
    nativeUsageComplete: anyNativeComplete,
  };
}

export function buildInspectReport(params: {
  issueKey: string;
  namespace: string;
  sessionId: string;
  session: Record<string, unknown> | null;
  traces: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
  artifactRuns?: Array<{
    runId: string;
    phase: string | null;
    sessionId: string | null;
    traceId: string | null;
    skillIds?: string[];
    skillProvenanceStatus?: "present" | "none" | null;
  }>;
  includeSafeContent?: boolean;
  /** Expected agent phases; defaults to planning + plan_review (ordinary Ready for Build). */
  expectedPhases?: string[];
}): LangfuseInspectReport {
  const issueKey = params.issueKey.trim();
  const expectedPhases = resolveExpectedPhases(params);

  const raw = buildRawTraces({
    issueKey,
    sessionId: params.sessionId,
    traces: params.traces,
    observations: params.observations,
    scores: params.scores,
  });

  const merged = mergeSessionBundle({
    traces: raw.traces,
    scores: raw.scores,
  });
  const traces = merged.traces;
  const allScores = merged.scores;
  const gaps: LangfuseInspectGap[] = [...raw.gaps, ...merged.gaps];

  const requiredObsIds = new Set<string>();
  const classified = classifyGenerationCandidates({
    traces,
    expectedPhases,
  });
  for (const c of classified) {
    if (c.required) requiredObsIds.add(c.observation.id);
  }

  for (const t of traces) {
    for (const obs of t.observations) {
      const obsHuman = Boolean(
        obs.name && extractIssueKeyFromDisplayName(obs.name),
      );
      if (!obs.linearIssueKey) {
        gaps.push({
          code: "observation_missing_issue_key",
          severity: obsHuman ? "error" : "warning",
          message: `Observation ${obs.name ?? obs.id} missing issue identity`,
          traceId: t.id || undefined,
          observationId: obs.id,
          reasonCode: "observation_missing_issue_key",
        });
      }

      const costIncompleteReason = generationCostIncompleteReason(obs);
      const isRequiredGen = requiredObsIds.has(obs.id);
      const isCandidate = classified.some(
        (c) => c.observation.id === obs.id,
      );
      if (isCandidate && costIncompleteReason) {
        gaps.push({
          code: "incomplete_cost_record",
          severity: isRequiredGen ? "error" : "warning",
          message: `Generation ${obs.name ?? obs.id} lacks complete cost record (${costIncompleteReason})`,
          traceId: t.id || undefined,
          observationId: obs.id,
          reasonCode: costIncompleteReason,
        });
      }

      if (observationClaimsSkillUsage(obs)) {
        const isReprojected = obs.metadata.reprojected === true;
        const matchingArtifact = (params.artifactRuns ?? []).find(
          (r) => r.runId && r.runId === obs.harnessRunId,
        );
        const artifactHasSkills =
          Boolean(
            matchingArtifact &&
              ((matchingArtifact.skillIds?.length ?? 0) > 0 ||
                matchingArtifact.skillProvenanceStatus === "present"),
          ) ||
          (params.artifactRuns ?? []).some(
            (r) =>
              (r.skillIds?.length ?? 0) > 0 ||
              r.skillProvenanceStatus === "present",
          );
        if ((isReprojected || matchingArtifact) && !artifactHasSkills) {
          gaps.push({
            code: "false_skill_provenance",
            severity: "error",
            message: `Observation ${obs.name ?? obs.id} claims skill usage without matching artifact evidence`,
            traceId: t.id || undefined,
            observationId: obs.id,
            reasonCode: "false_skill_provenance",
          });
        }
      }

      gaps.push(...collectPromptSkillInspectGaps(obs, t.id));
    }
  }

  const planningTraceNames = traces
    .filter(
      (t) =>
        isPlanningTraceDisplayName(t.name, issueKey) || t.phase === "planning",
    )
    .map((t) => t.name ?? t.id);
  const dedicatedPlanning = traces.some((t) =>
    isPlanningTraceDisplayName(t.name, issueKey),
  );
  const planReviewTraceNames = traces
    .filter(
      (t) =>
        isPlanReviewTraceDisplayName(t.name, issueKey) ||
        t.phase === "plan_review",
    )
    .map((t) => t.name ?? t.id);
  const dedicatedPlanReview = traces.some((t) =>
    isPlanReviewTraceDisplayName(t.name, issueKey),
  );

  if (expectedPhases.includes("planning") && !dedicatedPlanning) {
    gaps.push({
      code: "missing_planning_trace",
      severity: "error",
      message: `Missing dedicated planning trace named like "${issueKey} · planning"`,
      reasonCode: "missing_planning_trace",
    });
  }
  if (expectedPhases.includes("plan_review") && !dedicatedPlanReview) {
    gaps.push({
      code: "missing_plan_review_trace",
      severity: "error",
      message: `Missing dedicated plan_review trace named like "${issueKey} · plan_review"`,
      reasonCode: "missing_plan_review_trace",
    });
  }

  const agentObservationNames: string[] = [];
  const plannerAgentNames: string[] = [];
  const planReviewerAgentNames: string[] = [];
  for (const t of traces) {
    const planningTrace = isPlanningTraceDisplayName(t.name, issueKey);
    const planReviewTrace = isPlanReviewTraceDisplayName(t.name, issueKey);
    for (const o of t.observations) {
      const isAgent =
        o.type === "AGENT" ||
        o.type === "agent" ||
        Boolean(o.name?.includes(" · planner")) ||
        Boolean(o.name?.includes(" · plan_reviewer")) ||
        Boolean(o.name?.includes(" · implementer")) ||
        Boolean(o.name?.includes(" · reviser"));
      if (!isAgent) continue;
      if (o.name) agentObservationNames.push(o.name);
      if (isPlannerAgentDisplayName(o.name, issueKey)) {
        plannerAgentNames.push(o.name!);
      } else if (
        planningTrace &&
        (o.type === "AGENT" || o.type === "agent") &&
        (!o.name ||
          o.name.includes("planner") ||
          o.metadata?.agentRole === "planner")
      ) {
        plannerAgentNames.push(o.name ?? `${issueKey} · planner`);
      }
      if (isPlanReviewerAgentDisplayName(o.name, issueKey)) {
        planReviewerAgentNames.push(o.name!);
      } else if (
        planReviewTrace &&
        (o.type === "AGENT" || o.type === "agent") &&
        (!o.name ||
          o.name.includes("plan_reviewer") ||
          o.metadata?.agentRole === "plan_reviewer")
      ) {
        planReviewerAgentNames.push(o.name ?? `${issueKey} · plan_reviewer`);
      }
    }
  }
  if (expectedPhases.includes("planning") && plannerAgentNames.length === 0) {
    gaps.push({
      code: "missing_planner_agent",
      severity: "error",
      message: `Missing planner agent observation named like "${issueKey} · planner"`,
      reasonCode: "missing_planner_agent",
    });
  }
  if (
    expectedPhases.includes("plan_review") &&
    planReviewerAgentNames.length === 0
  ) {
    gaps.push({
      code: "missing_plan_reviewer_agent",
      severity: "error",
      message: `Missing plan_reviewer agent observation named like "${issueKey} · plan_reviewer"`,
      reasonCode: "missing_plan_reviewer_agent",
    });
  }

  for (const phase of expectedPhases) {
    const hasRequiredGen = classified.some(
      (c) => c.required && c.phase === phase,
    );
    if (!hasRequiredGen) {
      gaps.push({
        code: "missing_required_phase_generation",
        severity: "error",
        message: `Missing required generation for expected phase ${phase}`,
        reasonCode: phase,
      });
    }
  }

  for (const c of classified) {
    if (!c.required && c.exclusionReason) {
      gaps.push({
        code: "excluded_generation_candidate",
        severity: "warning",
        message: `Generation candidate ${c.observation.name ?? c.observation.id} excluded (${c.exclusionReason})`,
        traceId: c.traceId || undefined,
        observationId: c.observation.id,
        reasonCode: c.exclusionReason,
      });
    }
  }

  const conflictingCorrelations: LangfuseInspectReport["artifactComparison"]["conflictingCorrelations"] =
    [];
  for (const run of params.artifactRuns ?? []) {
    if (run.sessionId && run.sessionId !== params.sessionId) {
      conflictingCorrelations.push({
        traceId: run.traceId ?? "",
        field: "sessionId",
        langfuseValue: params.sessionId,
        artifactValue: run.sessionId,
      });
    }
    if (run.traceId) {
      const match = traces.find((t) => t.id === run.traceId);
      if (match && match.harnessRunId && run.runId && match.harnessRunId !== run.runId) {
        conflictingCorrelations.push({
          traceId: run.traceId,
          field: "harnessRunId",
          langfuseValue: match.harnessRunId,
          artifactValue: run.runId,
        });
      }
    }
  }
  for (const c of conflictingCorrelations) {
    gaps.push({
      code: "artifact_correlation_conflict",
      severity: "error",
      message: `Correlation conflict on ${c.field} for trace ${c.traceId}`,
      traceId: c.traceId || undefined,
      reasonCode: c.field,
    });
  }

  const requiredGens = classified.filter((c) => c.required);
  const costCompleteRequired = requiredGens.filter((c) =>
    generationCostComplete(c.observation),
  );
  const incompleteRequired = requiredGens.filter(
    (c) => !generationCostComplete(c.observation),
  );
  const generationCostCompleteAll =
    requiredGens.length > 0 && incompleteRequired.length === 0;

  const missingVisibleIssueKey = traces.some(
    (t) =>
      t.issueIdentityMissing &&
      Boolean(t.name && extractIssueKeyFromDisplayName(t.name)),
  );
  const scoreNames = [...new Set(allScores.map((s) => s.name))];

  const csvAcceptance = evaluateCursorCsvScoreAcceptance({
    traces,
    allScores,
    expectedPhases,
    gaps,
  });
  const cursorCsvTokenAcceptance = csvAcceptance.tokenAcceptance;
  const cursorCsvCostProxyAvailable = csvAcceptance.costProxyAvailable;
  const cursorCsvExactMonetaryCostAcceptance = generationCostCompleteAll;
  const cursorGenerationNativeUsageComplete =
    csvAcceptance.nativeUsageComplete;

  const requiredTracesPresent =
    (!expectedPhases.includes("planning") || dedicatedPlanning) &&
    (!expectedPhases.includes("plan_review") || dedicatedPlanReview);
  const requiredAgentsPresent =
    (!expectedPhases.includes("planning") || plannerAgentNames.length > 0) &&
    (!expectedPhases.includes("plan_review") ||
      planReviewerAgentNames.length > 0);
  const requiredGenerationsPresent =
    requiredGens.length > 0 &&
    expectedPhases.every((phase) =>
      requiredGens.some((c) => c.phase === phase),
    );

  const dedupedGaps = dedupeGaps(gaps);
  const errorGapCount = dedupedGaps.filter((g) => g.severity === "error").length;
  const warningGapCount = dedupedGaps.filter(
    (g) => g.severity === "warning",
  ).length;

  const provenanceValid = !dedupedGaps.some(
    (g) =>
      g.code === "false_skill_provenance" ||
      g.code === "false_native_skill_claim" ||
      g.code === "claimed_remote_prompt_without_link" ||
      g.code === "invalid_fallback_state" ||
      g.code === "missing_prompt_source" ||
      g.code === "missing_prompt_contract" ||
      g.code === "duplicate_skill_injection",
  );
  const correlationValid =
    conflictingCorrelations.length === 0 &&
    !dedupedGaps.some(
      (g) =>
        g.code === "duplicate_trace_identity_conflict" ||
        g.code === "duplicate_observation_identity_conflict" ||
        g.code === "duplicate_score_identity_conflict",
    );

  // Private core acceptance — does NOT include public-summary privacy validation.
  const coreComplete =
    errorGapCount === 0 &&
    requiredTracesPresent &&
    requiredAgentsPresent &&
    requiredGenerationsPresent &&
    generationCostCompleteAll &&
    provenanceValid &&
    correlationValid &&
    !missingVisibleIssueKey;

  const sessionMeta = normalizeMetadata(params.session?.metadata);
  const sessionDisplay =
    (typeof params.session?.name === "string" ? params.session.name : null) ??
    metadataString(sessionMeta, "linearIssueKey") ??
    sessionDisplayName(issueKey);

  const report: LangfuseInspectReport = {
    schemaVersion: 1,
    issueKey,
    namespace: params.namespace,
    sessionId: params.sessionId,
    sessionDisplayName: sessionDisplay,
    inspectedAt: new Date().toISOString(),
    expectedPhases,
    traces,
    scores: allScores,
    gaps: dedupedGaps,
    acceptance: {
      coreComplete,
      complete: coreComplete,
      missingVisibleIssueKey,
      hasPlanningTrace: dedicatedPlanning,
      hasPlannerAgent: plannerAgentNames.length > 0,
      hasPlanReviewTrace: dedicatedPlanReview,
      hasPlanReviewerAgent: planReviewerAgentNames.length > 0,
      requiredTracesPresent,
      requiredAgentsPresent,
      requiredGenerationsPresent,
      planningTraceNames,
      plannerAgentNames,
      planReviewTraceNames,
      planReviewerAgentNames,
      agentObservationNames,
      generationCostComplete: generationCostCompleteAll,
      requiredGenerationCount: requiredGens.length,
      costCompleteGenerationCount: costCompleteRequired.length,
      incompleteRequiredGenerationCount: incompleteRequired.length,
      uniqueGenerationCandidateCount: classified.length,
      excludedGenerationCandidateCount: classified.filter((c) => !c.required)
        .length,
      errorGapCount,
      warningGapCount,
      scoreNames,
      cursorCsvTokenAcceptance,
      cursorCsvCostProxyAvailable,
      cursorCsvExactMonetaryCostAcceptance,
      cursorGenerationNativeUsageComplete,
    },
    artifactComparison: {
      localRunCount: params.artifactRuns?.length ?? 0,
      conflictingCorrelations,
    },
  };

  if (params.includeSafeContent) {
    report.safeContent = {
      observations: traces.flatMap((t) =>
        t.observations.map((o) => ({
          id: o.id,
          inputSha256: o.inputSha256,
          outputSha256: o.outputSha256,
          inputByteCount: o.inputByteCount,
          outputByteCount: o.outputByteCount,
          redactionStatus:
            typeof o.metadata.redactionStatus === "string"
              ? o.metadata.redactionStatus
              : null,
        })),
      ),
    };
  }

  return report;
}
