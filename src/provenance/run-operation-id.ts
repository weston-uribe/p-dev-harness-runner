import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";

/**
 * Deterministic durable per-send execution key (providerRunOperationId).
 * Must be known and stable before agent.send. Never wall-clock alone.
 */
export function allocateProviderRunOperationId(input: {
  launchAttemptId: string;
  sendPurpose: string;
  /** Stable ordinal for distinct intentional sends within the same launch attempt. */
  sendOrdinal: number;
}): string {
  if (!Number.isInteger(input.sendOrdinal) || input.sendOrdinal < 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "providerRunOperationId requires a positive integer sendOrdinal.",
    );
  }
  const purpose = input.sendPurpose.trim();
  if (!purpose) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "providerRunOperationId requires a non-empty sendPurpose.",
    );
  }
  const canonical = [
    "p-dev.provider-run-operation-id.v1",
    input.launchAttemptId.trim(),
    purpose,
    String(input.sendOrdinal),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Reuse a previously persisted run-operation id, or allocate from durable operands.
 * Callers must persist the returned id before agent.send when restart-stable
 * identity is required.
 */
export function resolveProviderRunOperationId(input: {
  existingRunOperationId?: string | null;
  allocate: Parameters<typeof allocateProviderRunOperationId>[0];
}): string {
  const existing = input.existingRunOperationId?.trim();
  if (existing) {
    if (!/^[0-9a-f]{64}$/.test(existing)) {
      throw new CursorProvenanceError(
        "cursor_provenance_invalid_context",
        "Persisted providerRunOperationId has invalid format.",
      );
    }
    return existing;
  }
  return allocateProviderRunOperationId(input.allocate);
}

export function providerRunOperationIdPrefix(id: string): string {
  return id.slice(0, 12);
}
