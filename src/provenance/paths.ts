import { createHash } from "node:crypto";
import { launchAttemptIdPrefix } from "./launch-attempt-id.js";
import type { ProvenanceEventType } from "./events.js";

const PROVENANCE_ROOT = ".p-dev/cursor-cloud-agent-provenance";
const ROOT = `${PROVENANCE_ROOT}/events`;

/** Singleton per-attempt events. */
const SINGLETON_EVENTS = new Set<ProvenanceEventType>([
  "launch_intent",
  "provider_call_started",
  "provider_agent_acknowledged",
]);

export function provenanceEventRemotePath(input: {
  launchAttemptId: string;
  eventType: ProvenanceEventType;
  /** Required for run-bound/completed (runHash) and failure/reconciliation/run-ops. */
  bindingOrStageId?: string;
}): string {
  const prefix = launchAttemptIdPrefix(input.launchAttemptId);
  const base = `${ROOT}/${prefix}/${input.launchAttemptId}`;

  if (SINGLETON_EVENTS.has(input.eventType)) {
    return `${base}/${input.eventType}.json`;
  }

  const binding = input.bindingOrStageId?.trim();
  if (!binding) {
    throw new Error(
      `bindingOrStageId required for event type ${input.eventType}`,
    );
  }
  // Public-safe binding id only (hashes / deterministic stage keys).
  const safe = binding.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return `${base}/${input.eventType}/${safe}.json`;
}

export function provenanceEventsRootPrefix(): string {
  return ROOT;
}

export function provenanceLifecycleRootPrefix(): string {
  return PROVENANCE_ROOT;
}

function safeLifecycleSegment(value: string, label: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  if (!safe) {
    throw new Error(`${label} is required`);
  }
  return safe;
}

export function safeEpochId(epochId: string): string {
  return safeLifecycleSegment(epochId, "epochId");
}

export function activationRecordRemotePath(epochId: string): string {
  return `${PROVENANCE_ROOT}/activations/${safeEpochId(epochId)}/activation.json`;
}

export function activationHistoryProofRemotePath(epochId: string): string {
  return `${PROVENANCE_ROOT}/activations/${safeEpochId(epochId)}/history-proof.json`;
}

export function coverageSnapshotRemotePath(epochId: string): string {
  return `${PROVENANCE_ROOT}/activations/${safeEpochId(epochId)}/coverage-snapshot.json`;
}

export function coverageSealRemotePath(epochId: string): string {
  return `${PROVENANCE_ROOT}/activations/${safeEpochId(epochId)}/seal.json`;
}

export function coverageGapRemotePath(
  epochId: string,
  gapDigest: string,
): string {
  return `${PROVENANCE_ROOT}/activations/${safeEpochId(epochId)}/gaps/${gapDigest}.json`;
}

export function coverageSupersessionRemotePath(
  supersessionDigest: string,
): string {
  return `${PROVENANCE_ROOT}/supersessions/${supersessionDigest}.json`;
}

export function coverageIntervalInvalidationRemotePath(
  supersessionDigest: string,
): string {
  return coverageSupersessionRemotePath(supersessionDigest);
}

/** Deterministic identity digest for lifecycle record paths (public-safe). */
export function lifecycleRecordIdentityDigest(input: {
  recordKind: string;
  epochId?: string;
  primaryDigest: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recordKind: input.recordKind,
        epochId: input.epochId ?? null,
        primaryDigest: input.primaryDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Derive path from a validated event (for coverage integrity). */
export function deriveProvenanceEventPath(
  event: {
    launchAttemptId: string;
    eventType: ProvenanceEventType;
    providerRunOperationId?: string;
    runHash?: string;
    failureStage?: string;
    failureCategory?: string;
    resolutionId?: string;
  },
): string {
  if (SINGLETON_EVENTS.has(event.eventType)) {
    return provenanceEventRemotePath({
      launchAttemptId: event.launchAttemptId,
      eventType: event.eventType,
    });
  }
  if (
    event.eventType === "provider_run_intent" ||
    event.eventType === "provider_run_call_started"
  ) {
    return provenanceEventRemotePath({
      launchAttemptId: event.launchAttemptId,
      eventType: event.eventType,
      bindingOrStageId: event.providerRunOperationId,
    });
  }
  if (
    event.eventType === "provider_run_bound" ||
    event.eventType === "execution_completed"
  ) {
    return provenanceEventRemotePath({
      launchAttemptId: event.launchAttemptId,
      eventType: event.eventType,
      bindingOrStageId: event.runHash,
    });
  }
  if (event.eventType === "launch_failed") {
    return provenanceEventRemotePath({
      launchAttemptId: event.launchAttemptId,
      eventType: event.eventType,
      bindingOrStageId: `${event.failureStage}:${event.failureCategory}`,
    });
  }
  if (event.eventType === "reconciliation_resolution") {
    return provenanceEventRemotePath({
      launchAttemptId: event.launchAttemptId,
      eventType: event.eventType,
      bindingOrStageId: event.resolutionId,
    });
  }
  throw new Error(`Cannot derive path for event type ${event.eventType}`);
}
