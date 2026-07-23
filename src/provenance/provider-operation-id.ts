import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";

/**
 * Deterministic durable execution-attempt key.
 * Must be allocated and persisted by orchestration before launch_intent.
 * Never derived from wall-clock time alone.
 */
export function allocateProviderOperationId(input: {
  issueKey: string;
  phase: string;
  harnessRunId: string;
  agentRole: string;
  action: string;
  generation: number;
  launchSurface: string;
  /** Stable ordinal for distinct intentional executions within the same harness run/phase. */
  operationOrdinal: number;
  priorAgentHash?: string | null;
}): string {
  if (!Number.isInteger(input.operationOrdinal) || input.operationOrdinal < 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "providerOperationId requires a positive integer operationOrdinal.",
    );
  }
  const canonical = [
    "p-dev.provider-operation-id.v1",
    input.issueKey.trim(),
    input.phase.trim(),
    input.harnessRunId.trim(),
    input.agentRole.trim(),
    input.action.trim(),
    String(input.generation),
    input.launchSurface.trim(),
    String(input.operationOrdinal),
    input.priorAgentHash?.trim() || "",
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Reuse a previously persisted operation id, or allocate one from durable operands.
 * Callers must persist the returned id before provider mutation when phaseExecutionId
 * is unavailable.
 */
export function resolveProviderOperationId(input: {
  existingOperationId?: string | null;
  allocate: Parameters<typeof allocateProviderOperationId>[0];
}): string {
  const existing = input.existingOperationId?.trim();
  if (existing) {
    if (!/^[0-9a-f]{64}$/.test(existing)) {
      throw new CursorProvenanceError(
        "cursor_provenance_invalid_context",
        "Persisted providerOperationId has invalid format.",
      );
    }
    return existing;
  }
  return allocateProviderOperationId(input.allocate);
}
