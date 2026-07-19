import type { NestedObservationHandle, PhaseTraceHandle } from "../types.js";
import { allowsLangfuseContentProjection } from "./profiles.js";
import type { EvaluationCaptureProfile } from "../types.js";
import { toolObservationName } from "./tool-classify.js";
import type { AgentCostRecord, AgentTelemetryEvent } from "./types.js";
import { boundRedactedContent } from "./redact.js";
import { MAX_LANGFUSE_CONTENT_CHARS } from "./bounds.js";
import { costProjectionFields } from "./cost.js";
import {
  aggregateGenerationDisplayName,
  defaultAgentRoleForPhase,
} from "../naming.js";

/**
 * Forward canonical telemetry events into Langfuse nested observations.
 * Content bodies only when capture profile is content-v1.
 */
export function createLangfuseTelemetryForwarder(params: {
  phaseTrace: PhaseTraceHandle | null | undefined;
  agentObservation: NestedObservationHandle | null | undefined;
  captureProfile: EvaluationCaptureProfile;
  issueKey: string;
  phase: string;
  phaseExecutionId: string;
  harnessRunId: string;
  linearTeamKey?: string | null;
  revisionCycleIndex?: number | null;
  agentRole?: string | null;
}): (event: AgentTelemetryEvent) => void {
  const toolHandles = new Map<string, NestedObservationHandle>();
  let generationStarted = false;
  let generationHandle: NestedObservationHandle | null = null;
  let pendingPromptInput: string | null = null;
  let pendingAssistantOutput: string | null = null;
  let lastModelId: string | undefined;
  let lastCost: AgentCostRecord | undefined;
  let lastEffectiveVariant: "standard" | "fast" | "none" | undefined;

  const role =
    params.agentRole ?? defaultAgentRoleForPhase(params.phase) ?? "agent";

  const identityMeta = (): Record<string, unknown> => ({
    linearIssueKey: params.issueKey,
    linearTeamKey: params.linearTeamKey ?? null,
    phase: params.phase,
    phaseExecutionId: params.phaseExecutionId,
    revisionCycleIndex: params.revisionCycleIndex ?? null,
    harnessRunId: params.harnessRunId,
    agentRole: role,
  });

  const ensureGeneration = (): NestedObservationHandle | null => {
    if (!params.agentObservation) return null;
    if (!generationStarted) {
      const name = aggregateGenerationDisplayName({
        issueKey: params.issueKey,
        role,
        effectiveVariant: lastEffectiveVariant,
      });
      generationHandle = params.agentObservation.startChild(name, "generation");
      generationHandle.update({
        metadata: {
          ...identityMeta(),
          usageAggregation: "cursor_run_aggregate",
          individualModelCallsAvailable: false,
          ...(lastEffectiveVariant
            ? { effectiveVariant: lastEffectiveVariant }
            : {}),
        },
      });
      generationStarted = true;
    }
    return generationHandle;
  };

  return (event: AgentTelemetryEvent) => {
    const root = params.phaseTrace;
    const agent = params.agentObservation;
    if (!root || !agent) return;

    const allowContent = allowsLangfuseContentProjection(params.captureProfile);

    try {
      if (event.kind === "prompt_provenance") {
        const langfusePromptLinked = event.payload.langfusePromptLinked === true;
        const meta: Record<string, unknown> = {
          ...identityMeta(),
          promptName: event.payload.promptName,
          promptContractVersion: event.payload.promptContractVersion,
          promptTemplateSha256: event.payload.promptTemplateSha256,
          renderedPromptSha256:
            (event.payload.renderedPromptArtifact as { sha256?: string } | undefined)
              ?.sha256 ?? event.payload.renderedPromptSha256,
          renderedPromptByteCount:
            (event.payload.renderedPromptArtifact as { byteCount?: number } | undefined)
              ?.byteCount ?? event.payload.renderedPromptByteCount,
          promptAssemblySchemaVersion: event.payload.promptAssemblySchemaVersion,
          promptProvider: event.payload.promptProvider,
          promptSource: event.payload.promptSource,
          providerPromptVersion: event.payload.providerPromptVersion ?? null,
          providerLabel: event.payload.providerLabel ?? null,
          providerTemplateSha256: event.payload.providerTemplateSha256 ?? null,
          localTemplateSha256: event.payload.localTemplateSha256,
          fallbackUsed: event.payload.fallbackUsed ?? false,
          fallbackReason: event.payload.fallbackReason ?? "none",
          skillInvocationMode: event.payload.skillInvocationMode,
          langfusePromptLinked,
          nativeCapabilityState: event.payload.nativeCapabilityState,
          componentOrdering: event.payload.componentOrdering,
          variablesUsed: event.payload.variablesUsed,
        };
        // Only attach Langfuse prompt-link metadata when a real remote prompt was used.
        // Never invent a prompt-version link for local fallback.
        if (
          langfusePromptLinked &&
          typeof event.payload.langfusePromptJson === "string"
        ) {
          try {
            meta.langfusePrompt = JSON.parse(event.payload.langfusePromptJson);
          } catch {
            meta.langfusePromptLinkError = "invalid_langfuse_prompt_json";
          }
        }
        agent.update({ metadata: meta });
        const gen = ensureGeneration();
        gen?.update({ metadata: meta });
        if (
          allowContent &&
          typeof event.payload.renderedPromptPreview === "string"
        ) {
          pendingPromptInput = boundRedactedContent(
            event.payload.renderedPromptPreview,
            MAX_LANGFUSE_CONTENT_CHARS,
          ).text;
          gen?.update({ input: pendingPromptInput });
        }
        return;
      }

      if (event.kind === "skill_provenance") {
        const skillsUsed = (event.payload.skillsUsed ??
          event.payload.declaredSkills ??
          []) as Array<Record<string, unknown>>;
        // Strip any invented discovery/invocation claims for production rendered runs.
        const sanitizedSkills = skillsUsed.map((s) => {
          const inclusionMethod = s.inclusionMethod;
          const discovered =
            inclusionMethod === "provider_native" ? s.discovered ?? null : null;
          const invoked =
            inclusionMethod === "provider_native" ? s.invoked ?? null : null;
          return {
            skillId: s.skillId,
            sourcePath: s.sourcePath,
            role: s.role,
            contentSha256: s.contentSha256,
            inclusionMethod,
            discovered,
            invoked,
            evidenceSource: s.evidenceSource ?? "local_render",
            fallbackReason: s.fallbackReason,
          };
        });
        const meta: Record<string, unknown> = {
          ...identityMeta(),
          skillProvenanceStatus: event.payload.skillProvenanceStatus ?? "none",
          skillsUsed: sanitizedSkills,
        };
        agent.update({ metadata: meta });
        ensureGeneration()?.update({ metadata: meta });
        return;
      }

      if (event.kind === "assistant_output") {
        if (
          allowContent &&
          typeof event.payload.contentPreview === "string"
        ) {
          pendingAssistantOutput = boundRedactedContent(
            event.payload.contentPreview,
            MAX_LANGFUSE_CONTENT_CHARS,
          ).text;
        }
        const meta: Record<string, unknown> = {
          ...identityMeta(),
          agentOutputByteCount: event.payload.charCount ?? event.payload.byteCount,
          hasAssistantOutput: event.payload.hasAssistantOutput ?? true,
        };
        agent.update({ metadata: meta });
        const gen = ensureGeneration();
        if (pendingAssistantOutput) {
          gen?.update({ output: pendingAssistantOutput, metadata: meta });
        } else {
          gen?.update({ metadata: meta });
        }
        return;
      }

      if (event.kind === "agent_run_started") {
        agent.update({
          metadata: {
            ...identityMeta(),
            cursorAgentId: event.payload.cursorAgentId,
            cursorRunId: event.payload.cursorRunId,
          },
        });
        return;
      }

      if (event.kind === "telemetry_completeness") {
        const c = event.payload.completeness as Record<string, unknown> | undefined;
        agent.update({
          metadata: {
            ...identityMeta(),
            telemetryCompletenessTraceInput: c?.trace_input_present,
            telemetryCompletenessTraceOutput: c?.trace_output_present,
            telemetryCompletenessAgentInput: c?.agent_input_present,
            telemetryCompletenessAgentOutput: c?.agent_output_present,
            telemetryCompletenessModel: c?.model_present,
            telemetryCompletenessUsage: c?.usage_present,
            telemetryCompletenessToolEvents: c?.tool_events_present,
            telemetryCompletenessToolCompletionRate:
              c?.tool_event_completion_rate,
            telemetryCompletenessPromptProvenance:
              c?.prompt_provenance_present,
            telemetryCompletenessSkillProvenance: c?.skill_provenance_present,
            telemetryCompletenessPmFeedback: c?.pm_feedback_present,
          },
        });
        return;
      }

      if (
        event.kind === "error" ||
        event.kind === "retry" ||
        event.kind === "cancellation"
      ) {
        const gen = ensureGeneration();
        gen?.update({
          metadata: {
            ...identityMeta(),
            terminalEventKind: event.kind,
            status: event.payload.status ?? event.kind,
          },
        });
        if (event.kind !== "retry") {
          gen?.end({
            metadata: {
              ...identityMeta(),
              terminalEventKind: event.kind,
              usageAggregation: "cursor_run_aggregate",
              individualModelCallsAvailable: false,
              ...(lastCost ? costProjectionFields(lastCost) : {}),
            },
            ...(lastModelId ? { model: lastModelId } : {}),
            ...(pendingPromptInput && allowContent
              ? { input: pendingPromptInput }
              : {}),
            ...(pendingAssistantOutput && allowContent
              ? { output: pendingAssistantOutput }
              : {}),
          });
          generationHandle = null;
        }
        return;
      }

      if (event.kind === "tool_call_started") {
        const callId = String(event.payload.callId ?? "");
        const toolName = String(event.payload.toolName ?? "unknown");
        if (!callId || toolHandles.has(callId)) return;
        const handle = agent.startChild(toolObservationName(toolName), "tool");
        handle.update({
          metadata: {
            ...identityMeta(),
            callId,
            toolName,
            status: "started",
            mutationClass: event.payload.mutationClass,
            filePath: event.payload.filePath,
          },
        });
        toolHandles.set(callId, handle);
        return;
      }

      if (event.kind === "tool_call_finished" || event.kind === "tool_result") {
        const callId = String(event.payload.callId ?? "");
        const handle = toolHandles.get(callId);
        if (!handle) return;
        if (event.kind === "tool_call_finished") {
          handle.end({
            metadata: {
              ...identityMeta(),
              callId,
              status: event.payload.status,
              durationMs: event.payload.durationMs,
              exitCode: event.payload.exitCode,
              stdoutByteCount: event.payload.stdoutByteCount,
              stderrByteCount: event.payload.stderrByteCount,
              mutationClass: event.payload.mutationClass,
            },
            ...(allowContent && event.payload.resultSummary
              ? { output: String(event.payload.resultSummary) }
              : {}),
          });
          toolHandles.delete(callId);
        }
        return;
      }

      if (event.kind === "model_usage" || event.kind === "agent_run_finished") {
        const usage = event.payload.usage as
          | {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
              reasoningTokens?: number;
              cost?: AgentCostRecord;
            }
          | undefined;
        const modelId =
          typeof event.payload.modelId === "string"
            ? event.payload.modelId
            : undefined;
        if (modelId) lastModelId = modelId;
        if (usage?.cost) lastCost = usage.cost;

        const modelParams = Array.isArray(event.payload.modelParams)
          ? (event.payload.modelParams as Array<{ id: string; value: string }>)
          : Array.isArray(event.payload.effectiveRequestedParams)
            ? (event.payload.effectiveRequestedParams as Array<{
                id: string;
                value: string;
              }>)
            : undefined;
        const fastFromParams = modelParams?.find((p) => p.id === "fast")?.value;
        const effectiveVariant =
          typeof event.payload.effectiveVariant === "string"
            ? (event.payload.effectiveVariant as "standard" | "fast" | "none")
            : fastFromParams === "true"
              ? "fast"
              : fastFromParams === "false"
                ? "standard"
                : undefined;
        if (effectiveVariant) {
          lastEffectiveVariant = effectiveVariant;
        }

        const gen = ensureGeneration();
        if (gen) {
          const usageDetails: Record<string, number> = {};
          if (typeof usage?.inputTokens === "number") {
            usageDetails.input = usage.inputTokens;
          }
          if (typeof usage?.outputTokens === "number") {
            usageDetails.output = usage.outputTokens;
          }
          if (typeof usage?.totalTokens === "number") {
            usageDetails.total = usage.totalTokens;
          }
          if (typeof usage?.cacheReadTokens === "number") {
            usageDetails.cache_read = usage.cacheReadTokens;
          }
          if (typeof usage?.cacheWriteTokens === "number") {
            usageDetails.cache_write = usage.cacheWriteTokens;
          }
          if (typeof usage?.reasoningTokens === "number") {
            usageDetails.reasoning = usage.reasoningTokens;
          }

          const cost = usage?.cost ?? lastCost;
          const costFields = cost
            ? costProjectionFields(cost)
            : {
                costSource: "unavailable",
                costUnavailableReason: "provider_did_not_report",
              };
          const costDetails: Record<string, number> | undefined =
            typeof costFields.costUsd === "number"
              ? { total: costFields.costUsd as number }
              : undefined;

          const updateAttrs = {
            model: modelId ?? lastModelId,
            usageDetails:
              Object.keys(usageDetails).length > 0 ? usageDetails : undefined,
            costDetails,
            metadata: {
              ...identityMeta(),
              usageAggregation: "cursor_run_aggregate",
              individualModelCallsAvailable: false,
              modelId: modelId ?? lastModelId ?? null,
              modelParams: modelParams ?? null,
              effectiveVariant: effectiveVariant ?? lastEffectiveVariant ?? null,
              fast:
                fastFromParams === "true"
                  ? true
                  : fastFromParams === "false"
                    ? false
                    : null,
              parameterEvidenceSource:
                event.payload.parameterEvidenceSource ?? null,
              variantEvidenceSource:
                event.payload.variantEvidenceSource ?? null,
              providerDefaultParams:
                event.payload.providerDefaultParams ?? null,
              harnessDefaultParams: event.payload.harnessDefaultParams ?? null,
              ...costFields,
              cursorAgentId: event.payload.cursorAgentId,
              cursorRunId: event.payload.cursorRunId,
            },
            ...(pendingPromptInput && allowContent
              ? { input: pendingPromptInput }
              : {}),
            ...(pendingAssistantOutput && allowContent
              ? { output: pendingAssistantOutput }
              : {}),
          };

          gen.update(updateAttrs);
          if (event.kind === "agent_run_finished") {
            gen.end(updateAttrs);
            generationHandle = null;
          }
        }
      }

      if (event.kind === "pm_feedback" && allowContent) {
        const content =
          typeof event.payload.contentPreview === "string"
            ? event.payload.contentPreview
            : undefined;
        if (content) {
          root.setIO?.(
            {
              pmFeedback: boundRedactedContent(
                content,
                MAX_LANGFUSE_CONTENT_CHARS,
              ).text,
            },
            undefined,
          );
        }
      }
    } catch {
      // Non-authoritative
    }
  };
}
