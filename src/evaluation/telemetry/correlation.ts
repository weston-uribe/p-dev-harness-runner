import {
  deriveEvaluationSessionId,
  derivePhaseExecutionId,
} from "./ids.js";
import type {
  AgentTelemetryPhase,
  TelemetryCorrelationContext,
} from "./types.js";

export function buildTelemetryCorrelation(params: {
  namespace: string;
  issueKey: string;
  harnessRunId: string;
  phase: AgentTelemetryPhase;
  providerTraceId?: string;
}): TelemetryCorrelationContext {
  return {
    evaluationSessionId: deriveEvaluationSessionId(
      params.namespace,
      params.issueKey,
    ),
    harnessRunId: params.harnessRunId,
    phaseExecutionId: derivePhaseExecutionId(
      params.namespace,
      params.harnessRunId,
      params.phase,
    ),
    phase: params.phase,
    provider: "cursor",
    providerTraceId: params.providerTraceId,
  };
}
