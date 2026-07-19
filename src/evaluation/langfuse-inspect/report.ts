import {
  extractIssueKeyFromDisplayName,
  isPlannerAgentDisplayName,
  isPlanningTraceDisplayName,
  sessionDisplayName,
} from "../naming.js";
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

function isGenerationObservation(obs: LangfuseInspectObservation): boolean {
  return (
    obs.type === "GENERATION" ||
    obs.type === "generation" ||
    Boolean(obs.name?.includes("Cursor run"))
  );
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
  if (!isGenerationObservation(obs)) {
    return null;
  }

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
  const isGeneration =
    obs.type === "GENERATION" ||
    obs.type === "generation" ||
    Boolean(obs.name?.includes("Cursor run"));
  if (!isGeneration) return gaps;

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
    });
  }
  if (hasPromptMeta && !obs.promptContractVersion) {
    gaps.push({
      code: "missing_prompt_contract",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} missing promptContractVersion`,
      traceId: traceId || undefined,
      observationId: obs.id,
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
    });
  }
  if (source === "local" && (linked || hasLinkObject)) {
    gaps.push({
      code: "invalid_fallback_state",
      severity: "error",
      message: `Generation ${obs.name ?? obs.id} has local prompt source but claims a Langfuse prompt link`,
      traceId: traceId || undefined,
      observationId: obs.id,
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
          });
        }
      }
    }
  }

  return gaps;
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
}): LangfuseInspectReport {
  const issueKey = params.issueKey.trim();
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
  const scoresByTrace = new Map<string, LangfuseInspectScore[]>();
  for (const s of allScores) {
    if (!s.traceId) continue;
    const list = scoresByTrace.get(s.traceId) ?? [];
    list.push(s);
    scoresByTrace.set(s.traceId, list);
  }

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
    // Legacy pre-contract traces (p-dev.*) are warnings; human-readable names must carry identity.
    if (issueIdentityMissing) {
      gaps.push({
        code: "missing_visible_issue_key",
        severity: usesHumanReadableName || !isLegacyMachineName ? "error" : "warning",
        message: `Trace ${id || name || "unknown"} lacks visible Linear issue identity`,
        traceId: id || undefined,
      });
    } else if (linearIssueKey.toUpperCase() !== issueKey.toUpperCase()) {
      gaps.push({
        code: "issue_identity_conflict",
        severity: "error",
        message: `Trace ${id} identity ${linearIssueKey} conflicts with requested ${issueKey}`,
        traceId: id || undefined,
      });
    }

    const observations = obsByTrace.get(id) ?? [];
    // Include nested from trace payload
    for (const nested of asArray(raw.observations)) {
      const rec = asRecord(nested);
      if (!rec) continue;
      const mapped = mapObservation(rec);
      if (!observations.some((o) => o.id === mapped.id)) {
        observations.push(mapped);
      }
    }

    for (const obs of observations) {
      const obsHuman = Boolean(
        obs.name && extractIssueKeyFromDisplayName(obs.name),
      );
      if (!obs.linearIssueKey) {
        // Only hard-fail for contract-named observations; legacy/unnamed children are warnings.
        gaps.push({
          code: "observation_missing_issue_key",
          severity: obsHuman ? "error" : "warning",
          message: `Observation ${obs.name ?? obs.id} missing issue identity`,
          traceId: id || undefined,
          observationId: obs.id,
        });
      }
      const isGeneration =
        obs.type === "GENERATION" ||
        obs.type === "generation" ||
        Boolean(obs.name?.includes("Cursor run"));
      const costIncompleteReason = generationCostIncompleteReason(obs);
      if (isGeneration && costIncompleteReason) {
        gaps.push({
          code: "incomplete_cost_record",
          // Unnamed/reprojected generations may omit metadata in list APIs — warn only.
          severity: obsHuman ? "error" : "warning",
          message: `Generation ${obs.name ?? obs.id} lacks complete cost record (${costIncompleteReason})`,
          traceId: id || undefined,
          observationId: obs.id,
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
        // Historical reprojection must not invent skill usage. Fail when a
        // reprojected (or artifact-correlated) observation claims skills without
        // matching local artifact evidence.
        if (
          (isReprojected || matchingArtifact) &&
          !artifactHasSkills
        ) {
          gaps.push({
            code: "false_skill_provenance",
            severity: "error",
            message: `Observation ${obs.name ?? obs.id} claims skill usage without matching artifact evidence`,
            traceId: id || undefined,
            observationId: obs.id,
          });
        }
      }

      gaps.push(...collectPromptSkillInspectGaps(obs, id));
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
      scores: scoresByTrace.get(id) ?? [],
      issueIdentityMissing,
    });
  }

  const planningTraceNames = traces
    .filter((t) => isPlanningTraceDisplayName(t.name, issueKey) || t.phase === "planning")
    .map((t) => t.name ?? t.id);
  const dedicatedPlanning = traces.some((t) =>
    isPlanningTraceDisplayName(t.name, issueKey),
  );
  if (!dedicatedPlanning) {
    gaps.push({
      code: "missing_planning_trace",
      severity: "error",
      message: `Missing dedicated planning trace named like "${issueKey} · planning"`,
    });
  }

  const agentObservationNames: string[] = [];
  const plannerAgentNames: string[] = [];
  for (const t of traces) {
    const planningTrace = isPlanningTraceDisplayName(t.name, issueKey);
    for (const o of t.observations) {
      const isAgent =
        o.type === "AGENT" ||
        o.type === "agent" ||
        Boolean(o.name?.includes(" · planner")) ||
        Boolean(o.name?.includes(" · implementer")) ||
        Boolean(o.name?.includes(" · reviser"));
      if (!isAgent) continue;
      if (o.name) agentObservationNames.push(o.name);
      if (isPlannerAgentDisplayName(o.name, issueKey)) {
        plannerAgentNames.push(o.name!);
      } else if (
        planningTrace &&
        (o.type === "AGENT" || o.type === "agent") &&
        // Langfuse observation list may omit names for freshly reprojected spans;
        // an AGENT child under the planning display trace counts as the planner.
        (!o.name || o.name.includes("planner") || o.metadata?.agentRole === "planner")
      ) {
        plannerAgentNames.push(o.name ?? `${issueKey} · planner`);
      }
    }
  }
  if (plannerAgentNames.length === 0) {
    gaps.push({
      code: "missing_planner_agent",
      severity: "error",
      message: `Missing planner agent observation named like "${issueKey} · planner"`,
    });
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
    });
  }

  const generationObs = traces.flatMap((t) =>
    t.observations.filter((o) => {
      const human = Boolean(
        o.name && extractIssueKeyFromDisplayName(o.name),
      );
      return (
        human &&
        (o.type === "GENERATION" ||
          o.type === "generation" ||
          o.name?.includes("Cursor run"))
      );
    }),
  );
  // Also accept unnamed generations under human-readable phase traces (reprojection).
  const reprojectGenerations = traces.flatMap((t) =>
    extractIssueKeyFromDisplayName(t.name)
      ? t.observations.filter(
          (o) =>
            (o.type === "GENERATION" || o.type === "generation") &&
            !o.name,
        )
      : [],
  );
  const generationCostCompleteAll =
    generationObs.length > 0
      ? generationObs.every(generationCostComplete)
      : // Reprojected generations are often returned without names/metadata by list APIs.
        reprojectGenerations.length > 0;

  const missingVisibleIssueKey = traces.some(
    (t) =>
      t.issueIdentityMissing &&
      Boolean(t.name && extractIssueKeyFromDisplayName(t.name)),
  );
  const scoreNames = [...new Set(allScores.map((s) => s.name))];

  const sessionMeta = normalizeMetadata(params.session?.metadata);
  const sessionDisplay =
    (typeof params.session?.name === "string" ? params.session.name : null) ??
    metadataString(sessionMeta, "linearIssueKey") ??
    sessionDisplayName(issueKey);

  // Complete when human-readable planning+planner exist and no error-severity gaps remain.
  // Legacy p-dev.* traces may still be present as warnings.
  const complete =
    gaps.filter((g) => g.severity === "error").length === 0 &&
    dedicatedPlanning &&
    plannerAgentNames.length > 0 &&
    !missingVisibleIssueKey;

  const report: LangfuseInspectReport = {
    schemaVersion: 1,
    issueKey,
    namespace: params.namespace,
    sessionId: params.sessionId,
    sessionDisplayName: sessionDisplay,
    inspectedAt: new Date().toISOString(),
    traces,
    scores: allScores,
    gaps,
    acceptance: {
      complete,
      missingVisibleIssueKey,
      hasPlanningTrace: dedicatedPlanning,
      hasPlannerAgent: plannerAgentNames.length > 0,
      planningTraceNames,
      plannerAgentNames,
      agentObservationNames,
      generationCostComplete: generationCostCompleteAll,
      scoreNames,
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
