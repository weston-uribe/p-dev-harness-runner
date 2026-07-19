import {
  AGENT_TELEMETRY_SCHEMA_VERSION,
  type AgentTelemetryEvent,
  type AgentTelemetryEventKind,
} from "./types.js";

const REQUIRED_ENVELOPE_KEYS = [
  "schemaVersion",
  "eventId",
  "evaluationSessionId",
  "harnessRunId",
  "phaseExecutionId",
  "phase",
  "provider",
  "timestamp",
  "kind",
  "payload",
] as const;

const VALID_KINDS = new Set<AgentTelemetryEventKind>([
  "agent_run_started",
  "agent_run_finished",
  "assistant_output",
  "model_usage",
  "tool_call_started",
  "tool_call_finished",
  "tool_result",
  "error",
  "retry",
  "cancellation",
  "prompt_provenance",
  "skill_provenance",
  "pm_feedback",
  "timing_milestone",
  "telemetry_completeness",
]);

export function validateTelemetryEvent(
  event: unknown,
): { ok: true; event: AgentTelemetryEvent } | { ok: false; reason: string } {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "not_object" };
  }
  const e = event as Record<string, unknown>;
  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (e[key] === undefined || e[key] === null) {
      return { ok: false, reason: `missing_${key}` };
    }
  }
  if (e.schemaVersion !== AGENT_TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, reason: "bad_schema_version" };
  }
  if (typeof e.eventId !== "string" || !e.eventId) {
    return { ok: false, reason: "bad_eventId" };
  }
  if (typeof e.evaluationSessionId !== "string" || !e.evaluationSessionId) {
    return { ok: false, reason: "bad_evaluationSessionId" };
  }
  if (typeof e.harnessRunId !== "string" || !e.harnessRunId) {
    return { ok: false, reason: "bad_harnessRunId" };
  }
  if (typeof e.phaseExecutionId !== "string" || !e.phaseExecutionId) {
    return { ok: false, reason: "bad_phaseExecutionId" };
  }
  if (typeof e.phase !== "string") {
    return { ok: false, reason: "bad_phase" };
  }
  if (e.provider !== "cursor") {
    return { ok: false, reason: "bad_provider" };
  }
  if (typeof e.timestamp !== "string" || !e.timestamp) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (typeof e.kind !== "string" || !VALID_KINDS.has(e.kind as AgentTelemetryEventKind)) {
    return { ok: false, reason: "bad_kind" };
  }
  if (!e.payload || typeof e.payload !== "object") {
    return { ok: false, reason: "bad_payload" };
  }
  return { ok: true, event: e as unknown as AgentTelemetryEvent };
}
