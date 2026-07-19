import { createHash } from "node:crypto";
import { deriveSessionId } from "../identifiers.js";
import type { AgentTelemetryPhase } from "./types.js";

const PHASE_EXECUTION_PREFIX = "p-dev:phase-execution:v1";
const EVENT_ID_PREFIX = "p-dev:telemetry-event:v1";

function sha256Hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Alias for evaluation session — same as Langfuse session when enabled, but derived independently. */
export function deriveEvaluationSessionId(
  namespace: string,
  issueKey: string,
): string {
  return deriveSessionId(namespace, issueKey);
}

export function derivePhaseExecutionId(
  namespace: string,
  harnessRunId: string,
  phase: AgentTelemetryPhase,
): string {
  return sha256Hex(
    `${PHASE_EXECUTION_PREFIX}:${namespace}:${harnessRunId}:${phase}`,
  );
}

/**
 * Deterministic event ID for replay/retry-safe correlation.
 * Include a stable discriminator (e.g. call_id + status, or sequence key).
 */
export function deriveTelemetryEventId(
  phaseExecutionId: string,
  kind: string,
  discriminator: string,
): string {
  return sha256Hex(
    `${EVENT_ID_PREFIX}:${phaseExecutionId}:${kind}:${discriminator}`,
  );
}
