import type { GenerationExclusionReason } from "./types.js";
import { metadataNumber, metadataString } from "./client.js";
import type {
  LangfuseInspectObservation,
  LangfuseInspectTrace,
} from "./types.js";

export function isGenerationCandidate(
  obs: LangfuseInspectObservation,
): boolean {
  const type = obs.type?.toUpperCase() ?? "";
  // Agent/span/event containers are not generation candidates unless they also
  // carry generation-like model/token/cost/Cursor-run signals.
  const isAgentLike =
    type === "AGENT" || type === "SPAN" || type === "EVENT" || type === "TOOL";

  if (type === "GENERATION") return true;
  if (obs.name?.includes("Cursor run")) return true;

  const hasModel =
    Boolean(obs.model?.trim()) || Boolean(metadataString(obs.metadata, "modelId"));
  const hasCost =
    Boolean(obs.costSource?.trim()) ||
    typeof obs.costUsd === "number" ||
    metadataNumber(obs.metadata, "providerReportedCostUsd") != null ||
    metadataNumber(obs.metadata, "estimatedCostUsd") != null;
  const hasTokens =
    Boolean(obs.usage && Object.keys(obs.usage).length > 0) ||
    metadataNumber(obs.metadata, "cursorUsageInputTokens") != null ||
    metadataNumber(obs.metadata, "cursorUsageOutputTokens") != null;
  const hasRunCorrelation =
    Boolean(obs.phaseExecutionId?.trim()) ||
    Boolean(obs.cursorRunId?.trim()) ||
    Boolean(metadataString(obs.metadata, "cursorRunId"));

  if (hasModel || hasCost || hasTokens) return true;
  // Correlation alone only counts for non-agent containers (fail-closed for
  // unnamed generation rows that omit type but carry phase/run ids).
  if (!isAgentLike && hasRunCorrelation) return true;
  return false;
}

export function observationPhase(
  obs: LangfuseInspectObservation,
  trace: LangfuseInspectTrace,
): string | null {
  return obs.phase?.trim() || trace.phase?.trim() || null;
}

export function hasDurablePhaseCorrelation(
  obs: LangfuseInspectObservation,
  expectedPhase: string,
  trace: LangfuseInspectTrace,
): boolean {
  const phase = observationPhase(obs, trace);
  if (phase !== expectedPhase) return false;
  return Boolean(
    obs.phaseExecutionId?.trim() ||
      obs.cursorRunId?.trim() ||
      obs.harnessRunId?.trim() ||
      metadataString(obs.metadata, "phaseExecutionId") ||
      metadataString(obs.metadata, "cursorRunId"),
  );
}

export function isNamedGeneration(obs: LangfuseInspectObservation): boolean {
  return Boolean(obs.name?.trim());
}

export interface ClassifiedGeneration {
  observation: LangfuseInspectObservation;
  traceId: string;
  phase: string | null;
  required: boolean;
  exclusionReason: GenerationExclusionReason | null;
}

/**
 * Classify generation candidates against expected agent phases.
 * Fail-closed: candidates associated with expected phases are required.
 * Unnamed candidates count as required only with durable phase correlation;
 * incomplete unnamed correlated gens remain required (they fail cost completeness).
 */
export function classifyGenerationCandidates(params: {
  traces: LangfuseInspectTrace[];
  expectedPhases: string[];
}): ClassifiedGeneration[] {
  const expected = new Set(params.expectedPhases);
  const out: ClassifiedGeneration[] = [];

  for (const trace of params.traces) {
    const tracePhase = trace.phase?.trim() || null;
    for (const obs of trace.observations) {
      if (!isGenerationCandidate(obs)) continue;
      const phase = observationPhase(obs, trace);
      const associated =
        (phase != null && expected.has(phase)) ||
        (tracePhase != null && expected.has(tracePhase));

      if (!associated) {
        out.push({
          observation: obs,
          traceId: trace.id,
          phase,
          required: false,
          exclusionReason: "not_associated_with_expected_phase",
        });
        continue;
      }

      const expectedPhase = phase && expected.has(phase) ? phase : tracePhase!;
      if (
        !isNamedGeneration(obs) &&
        !hasDurablePhaseCorrelation(obs, expectedPhase, trace)
      ) {
        out.push({
          observation: obs,
          traceId: trace.id,
          phase: expectedPhase,
          required: false,
          exclusionReason: "unnamed_without_durable_phase_correlation",
        });
        continue;
      }

      out.push({
        observation: obs,
        traceId: trace.id,
        phase: expectedPhase,
        required: true,
        exclusionReason: null,
      });
    }
  }

  return out;
}
