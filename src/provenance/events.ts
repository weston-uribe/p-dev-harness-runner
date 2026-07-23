import { createHash } from "node:crypto";
import type { EncryptionEnvelope } from "./encryption.js";
import { envelopeMetadataForDigest } from "./encryption.js";
import type { LinearHarnessLaunchContext } from "./launch-context.js";
import { canonicalLaunchContextDigest } from "./launch-context.js";
import { PROVENANCE_WRITER_VERSION } from "./launch-surfaces.js";
import type {
  ReconciliationEvidenceSource,
  ReconciliationPayload,
  ReconciliationResolutionKind,
} from "./reconciliation.js";

export type TransitionSemantics =
  | { eventType: "launch_intent" }
  | { eventType: "provider_call_started" }
  | { eventType: "provider_agent_acknowledged" }
  | { eventType: "provider_run_intent"; providerRunOperationId: string }
  | { eventType: "provider_run_call_started"; providerRunOperationId: string }
  | { eventType: "provider_run_bound"; providerRunOperationId: string; runHash: string }
  | { eventType: "execution_completed"; providerRunOperationId: string; runHash: string }
  | { eventType: "launch_failed"; failureStage: string }
  | {
      eventType: "reconciliation_resolution";
      resolutionId: string;
      affectedOperationId: string;
      resolutionKind: string;
    };

export function deriveProvenanceTransitionId(semantics: TransitionSemantics): string {
  switch (semantics.eventType) {
    case "launch_intent":
      return "launch_intent";
    case "provider_call_started":
      return "provider_call_started";
    case "provider_agent_acknowledged":
      return "provider_agent_acknowledged";
    case "provider_run_intent":
      return `provider_run_intent:${semantics.providerRunOperationId}`;
    case "provider_run_call_started":
      return `provider_run_call_started:${semantics.providerRunOperationId}`;
    case "provider_run_bound":
      return `provider_run_bound:${semantics.providerRunOperationId}:${semantics.runHash}`;
    case "execution_completed":
      return `execution_completed:${semantics.providerRunOperationId}:${semantics.runHash}`;
    case "launch_failed":
      return `launch_failed:${semantics.failureStage}`;
    case "reconciliation_resolution":
      return `reconciliation_resolution:${semantics.resolutionKind}:${semantics.resolutionId}:${semantics.affectedOperationId}`;
    default: {
      const _exhaustive: never = semantics;
      return _exhaustive;
    }
  }
}

export function transitionSemanticsFromEvent(event: ProvenanceEvent): TransitionSemantics {
  switch (event.eventType) {
    case "launch_intent":
      return { eventType: "launch_intent" };
    case "provider_call_started":
      return { eventType: "provider_call_started" };
    case "provider_agent_acknowledged":
      return { eventType: "provider_agent_acknowledged" };
    case "provider_run_intent":
      return {
        eventType: "provider_run_intent",
        providerRunOperationId: event.providerRunOperationId,
      };
    case "provider_run_call_started":
      return {
        eventType: "provider_run_call_started",
        providerRunOperationId: event.providerRunOperationId,
      };
    case "provider_run_bound":
      return {
        eventType: "provider_run_bound",
        providerRunOperationId: event.providerRunOperationId,
        runHash: event.runHash,
      };
    case "execution_completed":
      return {
        eventType: "execution_completed",
        providerRunOperationId: event.providerRunOperationId,
        runHash: event.runHash,
      };
    case "launch_failed":
      return {
        eventType: "launch_failed",
        failureStage: event.failureStage,
      };
    case "reconciliation_resolution":
      return {
        eventType: "reconciliation_resolution",
        resolutionId: event.resolutionId,
        affectedOperationId: event.affectedOperationId,
        resolutionKind: event.resolutionKind,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export const PROVENANCE_EVENT_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-provenance.v1" as const;

export type ProvenanceEventType =
  | "launch_intent"
  | "provider_call_started"
  | "provider_agent_acknowledged"
  | "provider_run_intent"
  | "provider_run_call_started"
  | "provider_run_bound"
  | "execution_completed"
  | "launch_failed"
  | "reconciliation_resolution";

export interface ExecutionWindow {
  /** Inclusive start instant (UTC ISO). */
  startInclusive: string;
  /** Exclusive end instant (UTC ISO); null until terminal. */
  endExclusive: string | null;
  startEvidenceSource:
    | "provider_run_timestamp"
    | "local_run_acknowledged_timestamp";
  endEvidenceSource:
    | "provider_terminal_timestamp"
    | "local_terminal_observation_timestamp"
    | null;
}

export interface ProvenanceEventBase {
  schemaKind: typeof PROVENANCE_EVENT_SCHEMA_KIND;
  schemaVersion: "1";
  eventId: string;
  eventType: ProvenanceEventType;
  launchAttemptId: string;
  /** Deterministic transition identity (not a race-dependent sequence). */
  transitionId: string;
  launchContextDigest: string;
  /** Authoritative first-write timestamp; retained on idempotent retry. */
  recordedAt: string;
  producerVersion: string;
  sourceRepositorySha: string;
  runnerSnapshotVersion: string;
  workflowRunId: string | null;
  writerVersion: typeof PROVENANCE_WRITER_VERSION;
  canonicalSemanticDigest: string;
}

export interface LaunchIntentEvent extends ProvenanceEventBase {
  eventType: "launch_intent";
  launchContext: LinearHarnessLaunchContext;
}

export interface ProviderCallStartedEvent extends ProvenanceEventBase {
  eventType: "provider_call_started";
}

export interface ProviderAgentAcknowledgedEvent extends ProvenanceEventBase {
  eventType: "provider_agent_acknowledged";
  agentHash: string;
  agentIdEnvelope: EncryptionEnvelope;
}

export interface ProviderRunIntentEvent extends ProvenanceEventBase {
  eventType: "provider_run_intent";
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
}

export interface ProviderRunCallStartedEvent extends ProvenanceEventBase {
  eventType: "provider_run_call_started";
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
}

export interface ProviderRunBoundEvent extends ProvenanceEventBase {
  eventType: "provider_run_bound";
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
  agentHash: string;
  agentIdEnvelope: EncryptionEnvelope;
  runHash: string;
  runIdEnvelope: EncryptionEnvelope;
  executionBindingDigest: string;
  executionWindow: ExecutionWindow;
  providerSdkApiVersion: string | null;
  linearIssueKey: string;
  phase: string;
  phaseExecutionId: string | null;
  harnessRunId: string;
  action: string;
  generation: number;
}

export interface ExecutionCompletedEvent extends ProvenanceEventBase {
  eventType: "execution_completed";
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
  agentHash: string;
  runHash: string;
  terminalStatus: string;
  executionWindow: ExecutionWindow;
  executionWindowDigest: string;
  completionEvidenceSource: string;
}

export interface LaunchFailedEvent extends ProvenanceEventBase {
  eventType: "launch_failed";
  failureStage: string;
  failureCategory: string;
}

export interface ReconciliationResolutionEvent extends ProvenanceEventBase {
  eventType: "reconciliation_resolution";
  resolutionId: string;
  affectedOperationId: string;
  affectedOperationKind: "launch_attempt" | "run_operation";
  authoritativeResolutionInstant: string;
  resolutionKind: ReconciliationResolutionKind;
  evidenceSource: ReconciliationEvidenceSource;
  evidenceDigest: string;
  producerSchemaVersion: string;
  agentHash?: string;
  agentIdEnvelope?: EncryptionEnvelope;
  acknowledgmentTimestamp?: string;
  providerRunOperationId?: string;
  runHash?: string;
  sendSurface?: string;
  sendOrdinal?: number;
  executionStartTimestamp?: string;
  startEvidenceSource?: ExecutionWindow["startEvidenceSource"];
  recoveredBindingDigest?: string;
  runIdEnvelope?: EncryptionEnvelope;
  terminalStatus?: string;
  startInclusive?: string;
  endExclusive?: string;
  endEvidenceSource?: NonNullable<ExecutionWindow["endEvidenceSource"]>;
  executionWindowDigest?: string;
  executionBindingDigest?: string;
  recoveryEvidenceDigest?: string;
}

export type ProvenanceEvent =
  | LaunchIntentEvent
  | ProviderCallStartedEvent
  | ProviderAgentAcknowledgedEvent
  | ProviderRunIntentEvent
  | ProviderRunCallStartedEvent
  | ProviderRunBoundEvent
  | ExecutionCompletedEvent
  | LaunchFailedEvent
  | ReconciliationResolutionEvent;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Restart-stable semantic digest. Excludes recordedAt, nonce, ciphertext,
 * commit SHA, retry count, and elapsed time.
 */
export function computeCanonicalSemanticDigest(input: {
  eventType: ProvenanceEventType;
  launchAttemptId: string;
  transitionId: string;
  launchContextDigest: string;
  semanticPayload: Record<string, unknown>;
}): string {
  const canonical = {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventType: input.eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId: input.transitionId,
    launchContextDigest: input.launchContextDigest,
    semanticPayload: input.semanticPayload,
    writerVersion: PROVENANCE_WRITER_VERSION,
  };
  return createHash("sha256")
    .update(stableStringify(canonical), "utf8")
    .digest("hex");
}

export function computeEventId(input: {
  launchAttemptId: string;
  transitionId: string;
  eventType: ProvenanceEventType;
}): string {
  return createHash("sha256")
    .update(
      ["p-dev.provenance-event-id.v1", input.launchAttemptId, input.transitionId, input.eventType].join(
        "\n",
      ),
      "utf8",
    )
    .digest("hex");
}

export function executionBindingDigest(input: {
  launchAttemptId: string;
  agentHash: string;
  runHash: string;
  linearIssueKey: string;
  phase: string;
  harnessRunId: string;
  action: string;
  generation: number;
}): string {
  return createHash("sha256")
    .update(
      [
        "p-dev.execution-binding.v1",
        input.launchAttemptId,
        input.agentHash,
        input.runHash,
        input.linearIssueKey,
        input.phase,
        input.harnessRunId,
        input.action,
        String(input.generation),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

export function executionWindowDigest(window: ExecutionWindow): string {
  return createHash("sha256")
    .update(stableStringify(window), "utf8")
    .digest("hex");
}

export function validateExecutionWindow(window: ExecutionWindow): void {
  const start = Date.parse(window.startInclusive);
  if (!Number.isFinite(start)) {
    throw new Error("Invalid execution window start");
  }
  if (window.endExclusive !== null) {
    const end = Date.parse(window.endExclusive);
    if (!Number.isFinite(end) || end < start) {
      throw new Error("Invalid or reversed execution window");
    }
  }
}

export function semanticPayloadForAgentAck(input: {
  agentHash: string;
  envelope: EncryptionEnvelope;
}): Record<string, unknown> {
  return {
    agentHash: input.agentHash,
    envelopeMeta: envelopeMetadataForDigest(input.envelope),
  };
}

export function semanticPayloadForRunBound(input: {
  agentHash: string;
  runHash: string;
  executionBindingDigest: string;
  executionWindow: Omit<ExecutionWindow, "endExclusive" | "endEvidenceSource"> & {
    endExclusive: null;
    endEvidenceSource: null;
  };
  agentEnvelope: EncryptionEnvelope;
  runEnvelope: EncryptionEnvelope;
  linearIssueKey: string;
  phase: string;
  phaseExecutionId: string | null;
  harnessRunId: string;
  action: string;
  generation: number;
}): Record<string, unknown> {
  return {
    agentHash: input.agentHash,
    runHash: input.runHash,
    executionBindingDigest: input.executionBindingDigest,
    executionWindow: input.executionWindow,
    agentEnvelopeMeta: envelopeMetadataForDigest(input.agentEnvelope),
    runEnvelopeMeta: envelopeMetadataForDigest(input.runEnvelope),
    linearIssueKey: input.linearIssueKey,
    phase: input.phase,
    phaseExecutionId: input.phaseExecutionId,
    harnessRunId: input.harnessRunId,
    action: input.action,
    generation: input.generation,
  };
}

export function buildLaunchIntentEvent(input: {
  launchAttemptId: string;
  launchContext: LinearHarnessLaunchContext;
  recordedAt: string;
}): LaunchIntentEvent {
  const launchContextDigest = canonicalLaunchContextDigest(input.launchContext);
  const eventType = "launch_intent" as const;
  const transitionId = deriveProvenanceTransitionId({ eventType });
  const canonicalSemanticDigest = computeCanonicalSemanticDigest({
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    semanticPayload: { launchContextDigest },
  });
  return {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventId: computeEventId({
      launchAttemptId: input.launchAttemptId,
      transitionId,
      eventType,
    }),
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    recordedAt: input.recordedAt,
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: input.launchContext.sourceRepositorySha,
    runnerSnapshotVersion: input.launchContext.runnerSnapshotVersion,
    workflowRunId: input.launchContext.workflowRunId,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest,
    launchContext: input.launchContext,
  };
}

export function buildProviderCallStartedEvent(input: {
  launchAttemptId: string;
  launchContext: LinearHarnessLaunchContext;
  recordedAt: string;
}): ProviderCallStartedEvent {
  const launchContextDigest = canonicalLaunchContextDigest(input.launchContext);
  const eventType = "provider_call_started" as const;
  const transitionId = deriveProvenanceTransitionId({ eventType });
  const canonicalSemanticDigest = computeCanonicalSemanticDigest({
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    semanticPayload: {},
  });
  return {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventId: computeEventId({
      launchAttemptId: input.launchAttemptId,
      transitionId,
      eventType,
    }),
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    recordedAt: input.recordedAt,
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: input.launchContext.sourceRepositorySha,
    runnerSnapshotVersion: input.launchContext.runnerSnapshotVersion,
    workflowRunId: input.launchContext.workflowRunId,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest,
  };
}

export function buildProviderRunIntentEvent(input: {
  launchAttemptId: string;
  launchContext: LinearHarnessLaunchContext;
  recordedAt: string;
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
}): ProviderRunIntentEvent {
  const launchContextDigest = canonicalLaunchContextDigest(input.launchContext);
  const eventType = "provider_run_intent" as const;
  const transitionId = deriveProvenanceTransitionId({
    eventType,
    providerRunOperationId: input.providerRunOperationId,
  });
  const semanticPayload = {
    providerRunOperationId: input.providerRunOperationId,
    sendSurface: input.sendSurface,
    sendOrdinal: input.sendOrdinal,
  };
  return {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventId: computeEventId({
      launchAttemptId: input.launchAttemptId,
      transitionId,
      eventType,
    }),
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    recordedAt: input.recordedAt,
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: input.launchContext.sourceRepositorySha,
    runnerSnapshotVersion: input.launchContext.runnerSnapshotVersion,
    workflowRunId: input.launchContext.workflowRunId,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest: computeCanonicalSemanticDigest({
      eventType,
      launchAttemptId: input.launchAttemptId,
      transitionId,
      launchContextDigest,
      semanticPayload,
    }),
    providerRunOperationId: input.providerRunOperationId,
    sendSurface: input.sendSurface,
    sendOrdinal: input.sendOrdinal,
  };
}

export function buildProviderRunCallStartedEvent(input: {
  launchAttemptId: string;
  launchContext: LinearHarnessLaunchContext;
  recordedAt: string;
  providerRunOperationId: string;
  sendSurface: string;
  sendOrdinal: number;
}): ProviderRunCallStartedEvent {
  const launchContextDigest = canonicalLaunchContextDigest(input.launchContext);
  const eventType = "provider_run_call_started" as const;
  const transitionId = deriveProvenanceTransitionId({
    eventType,
    providerRunOperationId: input.providerRunOperationId,
  });
  const semanticPayload = {
    providerRunOperationId: input.providerRunOperationId,
    sendSurface: input.sendSurface,
    sendOrdinal: input.sendOrdinal,
  };
  return {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventId: computeEventId({
      launchAttemptId: input.launchAttemptId,
      transitionId,
      eventType,
    }),
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    recordedAt: input.recordedAt,
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: input.launchContext.sourceRepositorySha,
    runnerSnapshotVersion: input.launchContext.runnerSnapshotVersion,
    workflowRunId: input.launchContext.workflowRunId,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest: computeCanonicalSemanticDigest({
      eventType,
      launchAttemptId: input.launchAttemptId,
      transitionId,
      launchContextDigest,
      semanticPayload,
    }),
    providerRunOperationId: input.providerRunOperationId,
    sendSurface: input.sendSurface,
    sendOrdinal: input.sendOrdinal,
  };
}

export function buildReconciliationResolutionEvent(input: {
  launchAttemptId: string;
  launchContext: LinearHarnessLaunchContext;
  recordedAt: string;
  resolutionId: string;
  affectedOperationId: string;
  affectedOperationKind: "launch_attempt" | "run_operation";
  payload: ReconciliationPayload;
}): ReconciliationResolutionEvent {
  const launchContextDigest = canonicalLaunchContextDigest(input.launchContext);
  const eventType = "reconciliation_resolution" as const;
  const transitionId = deriveProvenanceTransitionId({
    eventType,
    resolutionId: input.resolutionId,
    affectedOperationId: input.affectedOperationId,
    resolutionKind: input.payload.resolutionKind,
  });
  const semanticPayload = {
    resolutionId: input.resolutionId,
    affectedOperationId: input.affectedOperationId,
    affectedOperationKind: input.affectedOperationKind,
    ...input.payload,
  };
  return {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1",
    eventId: computeEventId({
      launchAttemptId: input.launchAttemptId,
      transitionId,
      eventType,
    }),
    eventType,
    launchAttemptId: input.launchAttemptId,
    transitionId,
    launchContextDigest,
    recordedAt: input.recordedAt,
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: input.launchContext.sourceRepositorySha,
    runnerSnapshotVersion: input.launchContext.runnerSnapshotVersion,
    workflowRunId: input.launchContext.workflowRunId,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest: computeCanonicalSemanticDigest({
      eventType,
      launchAttemptId: input.launchAttemptId,
      transitionId,
      launchContextDigest,
      semanticPayload,
    }),
    resolutionId: input.resolutionId,
    affectedOperationId: input.affectedOperationId,
    affectedOperationKind: input.affectedOperationKind,
    authoritativeResolutionInstant: input.payload.authoritativeResolutionInstant,
    resolutionKind: input.payload.resolutionKind,
    evidenceSource: input.payload.evidenceSource,
    evidenceDigest: input.payload.evidenceDigest,
    producerSchemaVersion: input.payload.producerSchemaVersion,
    ...(input.payload.resolutionKind === "provider_agent_ack_recovered"
      ? {
          agentHash: input.payload.agentHash,
          agentIdEnvelope: input.payload.agentIdEnvelope,
          acknowledgmentTimestamp: input.payload.acknowledgmentTimestamp,
        }
      : {}),
    ...(input.payload.resolutionKind === "provider_run_binding_recovered"
      ? {
          providerRunOperationId: input.payload.providerRunOperationId,
          agentHash: input.payload.agentHash,
          runHash: input.payload.runHash,
          sendSurface: input.payload.sendSurface,
          sendOrdinal: input.payload.sendOrdinal,
          executionStartTimestamp: input.payload.executionStartTimestamp,
          startEvidenceSource: input.payload.startEvidenceSource,
          recoveredBindingDigest: input.payload.recoveredBindingDigest,
          agentIdEnvelope: input.payload.agentIdEnvelope,
          runIdEnvelope: input.payload.runIdEnvelope,
        }
      : {}),
    ...(input.payload.resolutionKind === "provider_terminal_window_recovered"
      ? {
          providerRunOperationId: input.payload.providerRunOperationId,
          agentHash: input.payload.agentHash,
          runHash: input.payload.runHash,
          sendSurface: input.payload.sendSurface,
          sendOrdinal: input.payload.sendOrdinal,
          terminalStatus: input.payload.terminalStatus,
          startInclusive: input.payload.startInclusive,
          endExclusive: input.payload.endExclusive,
          startEvidenceSource: input.payload.startEvidenceSource,
          endEvidenceSource: input.payload.endEvidenceSource,
          executionWindowDigest: input.payload.executionWindowDigest,
          executionBindingDigest: input.payload.executionBindingDigest,
          recoveryEvidenceDigest: input.payload.recoveryEvidenceDigest,
        }
      : {}),
  };
}
