import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";
import {
  assertKnownSendSurface,
  type ProductionSendSurface,
} from "./launch-surfaces.js";

/**
 * Deterministic durable per-send execution key (providerRunOperationId).
 * Must be known and stable before agent.send. Never wall-clock alone.
 */
export function allocateProviderRunOperationId(input: {
  launchAttemptId: string;
  sendSurface: ProductionSendSurface;
  /** Stable ordinal for distinct intentional sends within the same launch attempt. */
  sendOrdinal: number;
}): string {
  if (!Number.isInteger(input.sendOrdinal) || input.sendOrdinal < 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_invalid_context",
      "providerRunOperationId requires a positive integer sendOrdinal.",
    );
  }
  assertKnownSendSurface(input.sendSurface);
  const canonical = [
    "p-dev.provider-run-operation-id.v1",
    input.launchAttemptId.trim(),
    input.sendSurface,
    String(input.sendOrdinal),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Reuse a previously persisted run-operation id only when it equals the
 * canonical allocation from launchAttemptId + sendSurface + sendOrdinal.
 * Rejects arbitrary valid-looking 64-hex IDs.
 */
export function resolveProviderRunOperationId(input: {
  existingRunOperationId?: string | null;
  allocate: Parameters<typeof allocateProviderRunOperationId>[0];
}): string {
  const expected = allocateProviderRunOperationId(input.allocate);
  const existing = input.existingRunOperationId?.trim();
  if (existing) {
    if (!/^[0-9a-f]{64}$/.test(existing)) {
      throw new CursorProvenanceError(
        "cursor_provenance_invalid_context",
        "Persisted providerRunOperationId has invalid format.",
      );
    }
    if (existing !== expected) {
      throw new CursorProvenanceError(
        "cursor_provenance_invalid_context",
        "Persisted providerRunOperationId does not match launchAttemptId + sendSurface + sendOrdinal.",
      );
    }
    return existing;
  }
  return expected;
}

export function providerRunOperationIdPrefix(id: string): string {
  return id.slice(0, 12);
}
