/**
 * Typed reconciliation resolution kinds and evidence-source allowlists.
 */

import type { EncryptionEnvelope } from "./encryption.js";
import type { ExecutionWindow, ProvenanceEvent } from "./events.js";

export type ReconciliationResolutionKind =
  | "provider_mutation_proven_not_started"
  | "provider_agent_ack_recovered"
  | "provider_run_binding_recovered"
  | "provider_terminal_window_recovered"
  | "operation_permanently_unresolvable";

export const RECONCILIATION_RESOLUTION_KINDS = [
  "provider_mutation_proven_not_started",
  "provider_agent_ack_recovered",
  "provider_run_binding_recovered",
  "provider_terminal_window_recovered",
  "operation_permanently_unresolvable",
] as const satisfies readonly ReconciliationResolutionKind[];

export const ALLOWED_RECONCILIATION_EVIDENCE_SOURCES = [
  "operator_attestation",
  "provider_api_query",
  "github_actions_log",
  "harness_reconciliation_job",
] as const;

export type ReconciliationEvidenceSource =
  (typeof ALLOWED_RECONCILIATION_EVIDENCE_SOURCES)[number];

const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface ReconciliationSharedFields {
  evidenceSource: ReconciliationEvidenceSource;
  evidenceDigest: string;
  authoritativeResolutionInstant: string;
  producerSchemaVersion: string;
  sourceRepositorySha: string;
  runnerSnapshotVersion: string;
}

export type ProviderMutationProvenNotStartedPayload = ReconciliationSharedFields & {
  resolutionKind: "provider_mutation_proven_not_started";
  affectedOperationKind: "launch_attempt" | "run_operation";
  affectedOperationId: string;
};

export type ProviderAgentAckRecoveredPayload = ReconciliationSharedFields & {
  resolutionKind: "provider_agent_ack_recovered";
  agentHash: string;
  agentIdEnvelope?: EncryptionEnvelope;
  acknowledgmentTimestamp: string;
};

export type ProviderRunBindingRecoveredPayload = ReconciliationSharedFields & {
  resolutionKind: "provider_run_binding_recovered";
  providerRunOperationId: string;
  agentHash: string;
  runHash: string;
  sendSurface: string;
  sendOrdinal: number;
  executionStartTimestamp: string;
  startEvidenceSource: ExecutionWindow["startEvidenceSource"];
  recoveredBindingDigest: string;
  agentIdEnvelope?: EncryptionEnvelope;
  runIdEnvelope?: EncryptionEnvelope;
};

export type ProviderTerminalWindowRecoveredPayload = ReconciliationSharedFields & {
  resolutionKind: "provider_terminal_window_recovered";
  providerRunOperationId: string;
  launchAttemptId: string;
  agentHash: string;
  runHash: string;
  sendSurface: string;
  sendOrdinal: number;
  terminalStatus: string;
  startInclusive: string;
  endExclusive: string;
  startEvidenceSource: ExecutionWindow["startEvidenceSource"];
  endEvidenceSource: NonNullable<ExecutionWindow["endEvidenceSource"]>;
  executionWindowDigest: string;
  executionBindingDigest: string;
  recoveryEvidenceDigest: string;
};

export type OperationPermanentlyUnresolvablePayload = ReconciliationSharedFields & {
  resolutionKind: "operation_permanently_unresolvable";
  affectedOperationKind: "launch_attempt" | "run_operation";
  affectedOperationId: string;
};

export type ReconciliationPayload =
  | ProviderMutationProvenNotStartedPayload
  | ProviderAgentAckRecoveredPayload
  | ProviderRunBindingRecoveredPayload
  | ProviderTerminalWindowRecoveredPayload
  | OperationPermanentlyUnresolvablePayload;

export interface LaunchReconciliationContext {
  hasCallStarted: boolean;
  hasAgentAck: boolean;
  hasRunIntent: boolean;
  hasRunBound: boolean;
  hasRunComplete: boolean;
}

export interface RunReconciliationContext {
  hasRunIntent: boolean;
  hasRunCallStarted: boolean;
  hasRunBound: boolean;
  hasRunComplete: boolean;
  activityStart: string | null;
}

export function isReconciliationResolutionKind(
  value: string,
): value is ReconciliationResolutionKind {
  return (RECONCILIATION_RESOLUTION_KINDS as readonly string[]).includes(value);
}

export function isAllowedReconciliationEvidenceSource(
  value: string,
): value is ReconciliationEvidenceSource {
  return (ALLOWED_RECONCILIATION_EVIDENCE_SOURCES as readonly string[]).includes(
    value,
  );
}

function validateSharedFields(
  payload: ReconciliationSharedFields,
): "coverage_reconciliation_evidence_invalid" | null {
  if (!isAllowedReconciliationEvidenceSource(payload.evidenceSource)) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!DIGEST_RE.test(payload.evidenceDigest)) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!payload.authoritativeResolutionInstant?.trim()) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!Number.isFinite(Date.parse(payload.authoritativeResolutionInstant))) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!payload.producerSchemaVersion?.trim()) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!payload.sourceRepositorySha?.trim()) {
    return "coverage_reconciliation_evidence_invalid";
  }
  if (!payload.runnerSnapshotVersion?.trim()) {
    return "coverage_reconciliation_evidence_invalid";
  }
  return null;
}

export function validateReconciliationStructural(
  payload: ReconciliationPayload,
): "coverage_reconciliation_evidence_invalid" | null {
  if (!isReconciliationResolutionKind(payload.resolutionKind)) {
    return "coverage_reconciliation_evidence_invalid";
  }

  const shared = validateSharedFields(payload);
  if (shared) {
    return shared;
  }

  switch (payload.resolutionKind) {
    case "provider_mutation_proven_not_started":
      if (
        !payload.affectedOperationId?.trim() ||
        (payload.affectedOperationKind !== "launch_attempt" &&
          payload.affectedOperationKind !== "run_operation")
      ) {
        return "coverage_reconciliation_evidence_invalid";
      }
      return null;
    case "provider_agent_ack_recovered":
      if (
        !payload.agentHash?.trim() ||
        !payload.acknowledgmentTimestamp?.trim() ||
        !Number.isFinite(Date.parse(payload.acknowledgmentTimestamp))
      ) {
        return "coverage_reconciliation_evidence_invalid";
      }
      return null;
    case "provider_run_binding_recovered":
      if (
        !payload.providerRunOperationId?.trim() ||
        !payload.agentHash?.trim() ||
        !payload.runHash?.trim() ||
        !payload.sendSurface?.trim() ||
        !Number.isFinite(payload.sendOrdinal) ||
        payload.sendOrdinal <= 0 ||
        !payload.executionStartTimestamp?.trim() ||
        !Number.isFinite(Date.parse(payload.executionStartTimestamp)) ||
        !payload.startEvidenceSource ||
        !DIGEST_RE.test(payload.recoveredBindingDigest)
      ) {
        return "coverage_reconciliation_evidence_invalid";
      }
      return null;
    case "provider_terminal_window_recovered":
      if (
        !payload.providerRunOperationId?.trim() ||
        !payload.launchAttemptId?.trim() ||
        !payload.agentHash?.trim() ||
        !payload.runHash?.trim() ||
        !payload.sendSurface?.trim() ||
        !Number.isFinite(payload.sendOrdinal) ||
        payload.sendOrdinal <= 0 ||
        !payload.terminalStatus?.trim() ||
        !payload.startInclusive?.trim() ||
        !payload.endExclusive?.trim() ||
        !Number.isFinite(Date.parse(payload.startInclusive)) ||
        !Number.isFinite(Date.parse(payload.endExclusive)) ||
        Date.parse(payload.endExclusive) < Date.parse(payload.startInclusive) ||
        !payload.startEvidenceSource ||
        !payload.endEvidenceSource ||
        !DIGEST_RE.test(payload.executionWindowDigest) ||
        !DIGEST_RE.test(payload.executionBindingDigest) ||
        !DIGEST_RE.test(payload.recoveryEvidenceDigest)
      ) {
        return "coverage_reconciliation_evidence_invalid";
      }
      return null;
    case "operation_permanently_unresolvable":
      if (
        !payload.affectedOperationId?.trim() ||
        (payload.affectedOperationKind !== "launch_attempt" &&
          payload.affectedOperationKind !== "run_operation")
      ) {
        return "coverage_reconciliation_evidence_invalid";
      }
      return null;
    default: {
      const _exhaustive: never = payload;
      return _exhaustive;
    }
  }
}

/** Whether reconciliation may close overlapping activity in coverage projection. */
export function reconciliationClosesActivity(input: {
  resolutionKind: ReconciliationResolutionKind;
  affectedOperationKind: "launch_attempt" | "run_operation";
  launch: LaunchReconciliationContext;
  run: RunReconciliationContext | null;
  authoritativeResolutionInstant: string;
}): boolean {
  const instantMs = Date.parse(input.authoritativeResolutionInstant);
  if (!Number.isFinite(instantMs)) {
    return false;
  }

  if (input.resolutionKind === "operation_permanently_unresolvable") {
    return false;
  }

  if (input.resolutionKind === "provider_agent_ack_recovered") {
    return false;
  }

  if (input.affectedOperationKind === "launch_attempt") {
    const ctx = input.launch;
    if (
      input.resolutionKind === "provider_mutation_proven_not_started" &&
      !ctx.hasCallStarted &&
      !ctx.hasAgentAck &&
      !ctx.hasRunIntent &&
      !ctx.hasRunBound &&
      !ctx.hasRunComplete
    ) {
      return true;
    }
    return false;
  }

  const run = input.run;
  if (!run) {
    return false;
  }

  if (
    run.activityStart !== null &&
    instantMs < Date.parse(run.activityStart)
  ) {
    return false;
  }

  if (input.resolutionKind === "provider_mutation_proven_not_started") {
    return (
      run.hasRunIntent &&
      !run.hasRunCallStarted &&
      !run.hasRunBound &&
      !run.hasRunComplete
    );
  }

  if (input.resolutionKind === "provider_run_binding_recovered") {
    return false;
  }

  if (input.resolutionKind === "provider_terminal_window_recovered") {
    return run.hasRunBound && !run.hasRunComplete;
  }

  return false;
}

export function reconciliationContradictsExistingEvidence(input: {
  resolutionKind: ReconciliationResolutionKind;
  affectedOperationKind: "launch_attempt" | "run_operation";
  launch: LaunchReconciliationContext;
  run: RunReconciliationContext | null;
}): boolean {
  if (input.resolutionKind === "provider_mutation_proven_not_started") {
    if (input.affectedOperationKind === "launch_attempt") {
      return (
        input.launch.hasCallStarted ||
        input.launch.hasAgentAck ||
        input.launch.hasRunBound ||
        input.launch.hasRunComplete
      );
    }
    const run = input.run;
    return Boolean(run?.hasRunCallStarted || run?.hasRunBound || run?.hasRunComplete);
  }

  if (input.resolutionKind === "provider_agent_ack_recovered") {
    return input.launch.hasAgentAck;
  }

  if (input.resolutionKind === "provider_run_binding_recovered") {
    return Boolean(input.run?.hasRunBound);
  }

  if (input.resolutionKind === "provider_terminal_window_recovered") {
    return Boolean(input.run?.hasRunComplete);
  }

  return false;
}

function reconciliationOperationKey(event: {
  affectedOperationKind: "launch_attempt" | "run_operation";
  affectedOperationId: string;
}): string {
  return `${event.affectedOperationKind}:${event.affectedOperationId}`;
}

function reconciliationConflictReason(
  existing: ReconciliationResolutionKind,
  incoming: ReconciliationResolutionKind,
): string | null {
  if (existing === incoming) {
    return null;
  }
  if (
    existing === "operation_permanently_unresolvable" ||
    incoming === "operation_permanently_unresolvable"
  ) {
    return "permanently_unresolvable_conflicts_with_other_resolution";
  }
  if (
    (existing === "provider_mutation_proven_not_started" &&
      incoming === "provider_agent_ack_recovered") ||
    (incoming === "provider_mutation_proven_not_started" &&
      existing === "provider_agent_ack_recovered")
  ) {
    return "mutation_not_started_conflicts_with_ack_recovery";
  }
  if (
    existing === "provider_terminal_window_recovered" &&
    incoming === "provider_terminal_window_recovered"
  ) {
    return "duplicate_terminal_recovery";
  }
  if (
    (existing === "provider_run_binding_recovered" &&
      incoming === "provider_terminal_window_recovered") ||
    (incoming === "provider_run_binding_recovered" &&
      existing === "provider_terminal_window_recovered")
  ) {
    return null;
  }
  return `conflicting_resolution_kinds:${existing}:${incoming}`;
}

/** Order-independent conflict detection for the same affected operation. */
export function indexReconciliationConflicts(
  events: ProvenanceEvent[],
): string[] {
  const byOperation = new Map<
    string,
    Array<{ resolutionKind: ReconciliationResolutionKind; resolutionId: string }>
  >();

  for (const event of events) {
    if (event.eventType !== "reconciliation_resolution") {
      continue;
    }
    const key = reconciliationOperationKey(event);
    const rows = byOperation.get(key) ?? [];
    rows.push({
      resolutionKind: event.resolutionKind,
      resolutionId: event.resolutionId,
    });
    byOperation.set(key, rows);
  }

  const conflicts = new Set<string>();
  for (const [operationKey, rows] of byOperation) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const reason = reconciliationConflictReason(
          rows[i]!.resolutionKind,
          rows[j]!.resolutionKind,
        );
        if (reason) {
          conflicts.add(`${operationKey}:${reason}`);
        }
      }
    }
  }
  return [...conflicts].sort();
}

export function reconciliationPayloadFromEvent(
  event: Extract<ProvenanceEvent, { eventType: "reconciliation_resolution" }>,
): ReconciliationPayload {
  const shared: ReconciliationSharedFields = {
    evidenceSource: event.evidenceSource,
    evidenceDigest: event.evidenceDigest,
    authoritativeResolutionInstant: event.authoritativeResolutionInstant,
    producerSchemaVersion: event.producerSchemaVersion,
    sourceRepositorySha: event.sourceRepositorySha,
    runnerSnapshotVersion: event.runnerSnapshotVersion,
  };

  switch (event.resolutionKind) {
    case "provider_mutation_proven_not_started":
      return {
        resolutionKind: event.resolutionKind,
        affectedOperationKind: event.affectedOperationKind,
        affectedOperationId: event.affectedOperationId,
        ...shared,
      };
    case "provider_agent_ack_recovered":
      return {
        resolutionKind: event.resolutionKind,
        agentHash: event.agentHash!,
        agentIdEnvelope: event.agentIdEnvelope,
        acknowledgmentTimestamp: event.acknowledgmentTimestamp!,
        ...shared,
      };
    case "provider_run_binding_recovered":
      return {
        resolutionKind: event.resolutionKind,
        providerRunOperationId: event.providerRunOperationId!,
        agentHash: event.agentHash!,
        runHash: event.runHash!,
        sendSurface: event.sendSurface!,
        sendOrdinal: event.sendOrdinal!,
        executionStartTimestamp: event.executionStartTimestamp!,
        startEvidenceSource: event.startEvidenceSource!,
        recoveredBindingDigest: event.recoveredBindingDigest!,
        agentIdEnvelope: event.agentIdEnvelope,
        runIdEnvelope: event.runIdEnvelope,
        ...shared,
      };
    case "provider_terminal_window_recovered":
      return {
        resolutionKind: event.resolutionKind,
        providerRunOperationId: event.providerRunOperationId!,
        launchAttemptId: event.launchAttemptId,
        agentHash: event.agentHash!,
        runHash: event.runHash!,
        sendSurface: event.sendSurface!,
        sendOrdinal: event.sendOrdinal!,
        terminalStatus: event.terminalStatus!,
        startInclusive: event.startInclusive!,
        endExclusive: event.endExclusive!,
        startEvidenceSource: event.startEvidenceSource!,
        endEvidenceSource: event.endEvidenceSource!,
        executionWindowDigest: event.executionWindowDigest!,
        executionBindingDigest: event.executionBindingDigest!,
        recoveryEvidenceDigest: event.recoveryEvidenceDigest!,
        ...shared,
      };
    case "operation_permanently_unresolvable":
      return {
        resolutionKind: event.resolutionKind,
        affectedOperationKind: event.affectedOperationKind,
        affectedOperationId: event.affectedOperationId,
        ...shared,
      };
    default: {
      const _exhaustive: never = event.resolutionKind;
      throw new Error(`Unknown reconciliation kind: ${_exhaustive}`);
    }
  }
}
