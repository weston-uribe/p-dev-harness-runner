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
  // Tool/event/span/agent containers are never generation candidates by type.
  // Only GENERATION rows (or Cursor-run named rows) participate in cost gates.
  if (type === "TOOL" || type === "EVENT" || type === "SPAN") {
    return Boolean(obs.name?.includes("Cursor run"));
  }
  if (type === "AGENT") {
    return Boolean(obs.name?.includes("Cursor run"));
  }

  if (type === "GENERATION") return true;
  if (obs.name?.includes("Cursor run")) return true;

  const hasModel =
    Boolean(obs.model?.trim()) || Boolean(metadataString(obs.metadata, "modelId"));
  const hasCost =
    (Boolean(obs.costSource?.trim()) && obs.costSource !== "unavailable") ||
    (typeof obs.costUsd === "number" && obs.costUsd > 0) ||
    metadataNumber(obs.metadata, "providerReportedCostUsd") != null ||
    metadataNumber(obs.metadata, "estimatedCostUsd") != null;
  const hasTokens =
    Boolean(
      obs.usage &&
        Object.keys(obs.usage).some(
          (key) => typeof obs.usage?.[key] === "number" && obs.usage[key]! > 0,
        ),
    ) ||
    metadataNumber(obs.metadata, "cursorUsageInputTokens") != null ||
    metadataNumber(obs.metadata, "cursorUsageOutputTokens") != null;
  const hasRunCorrelation =
    Boolean(obs.phaseExecutionId?.trim()) ||
    Boolean(obs.cursorRunId?.trim()) ||
    Boolean(metadataString(obs.metadata, "cursorRunId"));

  if (hasModel || hasCost || hasTokens) return true;
  // Unnamed generation-like rows may omit type but carry phase/run correlation.
  if (hasRunCorrelation && !obs.name?.startsWith("p-dev.tool.")) return true;
  return false;
}

function phaseFromTraceDisplayName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const sep = name.indexOf(" · ");
  if (sep < 0) return null;
  const rest = name.slice(sep + 3).trim();
  const phase = rest.split(" · ")[0]?.trim();
  return phase || null;
}

export function observationPhase(
  obs: LangfuseInspectObservation,
  trace: LangfuseInspectTrace,
): string | null {
  return (
    obs.phase?.trim() ||
    trace.phase?.trim() ||
    phaseFromTraceDisplayName(trace.name)
  );
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
