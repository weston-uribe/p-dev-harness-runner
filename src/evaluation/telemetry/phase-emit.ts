import { appendTelemetryEvent } from "./writer.js";
import { deriveTelemetryEventId } from "./ids.js";
import {
  AGENT_TELEMETRY_SCHEMA_VERSION,
  type AgentTelemetryEvent,
  type ArtifactRef,
  type SkillProvenanceRecord,
  type TelemetryCorrelationContext,
} from "./types.js";
import type { PromptProvenance } from "./provenance.js";

function baseEvent(
  ctx: TelemetryCorrelationContext,
  kind: AgentTelemetryEvent["kind"],
  discriminator: string,
  payload: Record<string, unknown>,
): AgentTelemetryEvent {
  return {
    schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
    eventId: deriveTelemetryEventId(ctx.phaseExecutionId, kind, discriminator),
    evaluationSessionId: ctx.evaluationSessionId,
    harnessRunId: ctx.harnessRunId,
    phaseExecutionId: ctx.phaseExecutionId,
    phase: ctx.phase,
    provider: ctx.provider,
    timestamp: new Date().toISOString(),
    providerTraceId: ctx.providerTraceId,
    cursorAgentId: ctx.cursorAgentId,
    cursorRunId: ctx.cursorRunId,
    cursorRequestId: ctx.cursorRequestId,
    kind,
    payload,
  };
}

export async function emitPromptProvenanceEvent(
  runDirectory: string,
  ctx: TelemetryCorrelationContext,
  provenance: PromptProvenance & {
    promptName?: string;
    promptAssemblySchemaVersion?: number;
    renderedPromptPreview?: string;
    promptProvider?: string;
    promptSource?: string;
    providerPromptVersion?: number | null;
    providerLabel?: string | null;
    providerTemplateSha256?: string | null;
    localTemplateSha256?: string;
    fallbackUsed?: boolean;
    fallbackReason?: string;
    skillInvocationMode?: string;
    langfusePromptLinked?: boolean;
    /** Minimal Langfuse prompt link object JSON (name/version/labels only — no template body) */
    langfusePromptJson?: string | null;
    nativeCapabilityState?: string;
    componentOrdering?: string[];
    variablesUsed?: string[];
  },
  onTelemetryEvent?: (event: AgentTelemetryEvent) => void | Promise<void>,
): Promise<void> {
  const event = baseEvent(ctx, "prompt_provenance", "prompt", {
    promptName: provenance.promptName,
    promptContractVersion: provenance.promptContractVersion,
    promptTemplatePath: provenance.promptTemplatePath,
    promptTemplateSha256: provenance.promptTemplateSha256,
    promptAssemblySchemaVersion: provenance.promptAssemblySchemaVersion ?? 1,
    artifactRef: provenance.renderedPromptArtifact,
    renderedPromptSha256: provenance.renderedPromptArtifact?.sha256,
    renderedPromptByteCount: provenance.renderedPromptArtifact?.byteCount,
    ...(provenance.promptProvider
      ? { promptProvider: provenance.promptProvider }
      : {}),
    ...(provenance.promptSource ? { promptSource: provenance.promptSource } : {}),
    ...(provenance.providerPromptVersion !== undefined
      ? { providerPromptVersion: provenance.providerPromptVersion }
      : {}),
    ...(provenance.providerLabel !== undefined
      ? { providerLabel: provenance.providerLabel }
      : {}),
    ...(provenance.providerTemplateSha256 !== undefined
      ? { providerTemplateSha256: provenance.providerTemplateSha256 }
      : {}),
    ...(provenance.localTemplateSha256
      ? { localTemplateSha256: provenance.localTemplateSha256 }
      : {}),
    ...(provenance.fallbackUsed !== undefined
      ? { fallbackUsed: provenance.fallbackUsed }
      : {}),
    ...(provenance.fallbackReason
      ? { fallbackReason: provenance.fallbackReason }
      : {}),
    ...(provenance.skillInvocationMode
      ? { skillInvocationMode: provenance.skillInvocationMode }
      : {}),
    ...(provenance.langfusePromptLinked !== undefined
      ? { langfusePromptLinked: provenance.langfusePromptLinked }
      : {}),
    ...(provenance.langfusePromptJson
      ? { langfusePromptJson: provenance.langfusePromptJson }
      : {}),
    ...(provenance.nativeCapabilityState
      ? { nativeCapabilityState: provenance.nativeCapabilityState }
      : {}),
    ...(provenance.componentOrdering
      ? { componentOrdering: provenance.componentOrdering }
      : {}),
    ...(provenance.variablesUsed
      ? { variablesUsed: provenance.variablesUsed }
      : {}),
    ...(provenance.renderedPromptPreview
      ? { renderedPromptPreview: provenance.renderedPromptPreview }
      : {}),
  });
  await appendTelemetryEvent(runDirectory, event);
  await onTelemetryEvent?.(event);
}

export async function emitSkillProvenanceEvent(
  runDirectory: string,
  ctx: TelemetryCorrelationContext,
  skills: {
    eligibleSkills: SkillProvenanceRecord[];
    declaredSkills: SkillProvenanceRecord[];
    observedSkills: SkillProvenanceRecord[];
    skillsUsed?: Array<SkillProvenanceRecord & { inclusionMethod?: string }>;
    skillProvenanceStatus?: "present" | "none";
  },
  onTelemetryEvent?: (event: AgentTelemetryEvent) => void | Promise<void>,
): Promise<void> {
  const skillsUsed = skills.skillsUsed ?? skills.declaredSkills;
  const skillProvenanceStatus =
    skills.skillProvenanceStatus ??
    (skillsUsed.length > 0 ? "present" : "none");
  const event = baseEvent(ctx, "skill_provenance", "skills", {
    eligibleSkills: skills.eligibleSkills,
    declaredSkills: skills.declaredSkills,
    observedSkills: skills.observedSkills,
    skillsUsed,
    skillProvenanceStatus,
  });
  await appendTelemetryEvent(runDirectory, event);
  await onTelemetryEvent?.(event);
}

export async function emitPmFeedbackTelemetryEvent(
  runDirectory: string,
  ctx: TelemetryCorrelationContext,
  payload: {
    artifactRef: ArtifactRef | null;
    pmFeedbackCommentId: string;
    pmFeedbackWordCount: number;
    timeSinceHandoffMs: number | null;
    /** Bounded redacted preview for content-v1 Langfuse only; still stored as optional payload field. */
    contentPreview?: string;
  },
  onTelemetryEvent?: (event: AgentTelemetryEvent) => void | Promise<void>,
): Promise<void> {
  const event = baseEvent(ctx, "pm_feedback", payload.pmFeedbackCommentId, {
    artifactRef: payload.artifactRef,
    pmFeedbackCommentId: payload.pmFeedbackCommentId,
    pmFeedbackWordCount: payload.pmFeedbackWordCount,
    timeSinceHandoffMs: payload.timeSinceHandoffMs,
    ...(payload.contentPreview
      ? { contentPreview: payload.contentPreview }
      : {}),
  });
  await appendTelemetryEvent(runDirectory, event);
  await onTelemetryEvent?.(event);
}

export function agentObsMetadataFromObserved(observed: {
  agentId: string;
  runId: string;
  requestId?: string;
  status?: string;
  durationMs?: number | null;
  model?: {
    id: string;
    params?: Array<{ id: string; value: string }>;
  } | null;
  /** Requested selection when provider result omits params. */
  requestedModel?: {
    id: string;
    params?: Array<{ id: string; value: string }>;
    parameterEvidenceSource?: string;
    providerDefaultParams?: Array<{ id: string; value: string }>;
    harnessDefaultParams?: Array<{ id: string; value: string }>;
  } | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    cost?: { costSource?: string };
  } | null;
  completeness?: {
    model_present?: boolean;
    usage_present?: boolean;
    tool_events_present?: boolean;
    tool_event_completion_rate?: number | null;
    prompt_provenance_present?: boolean;
    skill_provenance_present?: boolean;
    agent_output_present?: boolean;
  };
  eventCounts?: { total?: number };
}): Record<string, unknown> {
  const usage = observed.usage;
  const providerParams = observed.model?.params;
  const requestedParams = observed.requestedModel?.params;
  const effectiveParams =
    providerParams && providerParams.length > 0
      ? providerParams
      : (requestedParams ?? []);
  const variantEvidenceSource =
    providerParams && providerParams.length > 0
      ? "provider_confirmed"
      : requestedParams
        ? "requested_model_parameters"
        : undefined;
  const fastValue = effectiveParams.find((param) => param.id === "fast")?.value;
  const effectiveVariant =
    fastValue === "true" ? "fast" : fastValue === "false" ? "standard" : "none";

  return {
    cursorAgentId: observed.agentId,
    cursorRunId: observed.runId,
    cursorRequestId: observed.requestId ?? null,
    cursorStatus: observed.status ?? null,
    cursorDurationMs: observed.durationMs ?? null,
    modelId: observed.model?.id ?? observed.requestedModel?.id ?? null,
    modelParams: effectiveParams.length > 0 ? effectiveParams : null,
    effectiveRequestedParams: effectiveParams.length > 0 ? effectiveParams : null,
    effectiveVariant,
    fast: fastValue === "true" ? true : fastValue === "false" ? false : null,
    parameterEvidenceSource:
      observed.requestedModel?.parameterEvidenceSource ?? null,
    variantEvidenceSource: variantEvidenceSource ?? null,
    providerDefaultParams:
      observed.requestedModel?.providerDefaultParams ?? null,
    harnessDefaultParams: observed.requestedModel?.harnessDefaultParams ?? null,
    costSource: usage?.cost?.costSource ?? "unavailable",
    costUnavailableReason:
      (usage?.cost as { costUnavailableReason?: string } | undefined)
        ?.costUnavailableReason ??
      (usage?.cost?.costSource === "unavailable" || !usage?.cost?.costSource
        ? "provider_did_not_report"
        : undefined),
    pricingRegistryVersion: (
      usage?.cost as { pricingRegistryVersion?: string } | undefined
    )?.pricingRegistryVersion,
    costUsd:
      (usage?.cost as { providerReportedCostUsd?: number; estimatedCostUsd?: number } | undefined)
        ?.providerReportedCostUsd ??
      (usage?.cost as { estimatedCostUsd?: number } | undefined)?.estimatedCostUsd,
    cursorUsageInputTokens: usage?.inputTokens,
    cursorUsageOutputTokens: usage?.outputTokens,
    cursorUsageTotalTokens: usage?.totalTokens,
    cursorUsageCacheReadTokens: usage?.cacheReadTokens,
    cursorUsageCacheWriteTokens: usage?.cacheWriteTokens,
    cursorUsageReasoningTokens: usage?.reasoningTokens,
    telemetryEventCount: observed.eventCounts?.total,
    usageAggregation: "cursor_run_aggregate",
    individualModelCallsAvailable: false,
    ...(observed.completeness
      ? {
          telemetryCompletenessModel: observed.completeness.model_present,
          telemetryCompletenessUsage: observed.completeness.usage_present,
          telemetryCompletenessToolEvents:
            observed.completeness.tool_events_present,
          telemetryCompletenessToolCompletionRate:
            observed.completeness.tool_event_completion_rate,
          telemetryCompletenessPromptProvenance:
            observed.completeness.prompt_provenance_present,
          telemetryCompletenessSkillProvenance:
            observed.completeness.skill_provenance_present,
          telemetryCompletenessAgentOutput:
            observed.completeness.agent_output_present,
        }
      : {}),
  };
}
