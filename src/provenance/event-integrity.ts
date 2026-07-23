/**
 * Event snapshot integrity — recompute digests/paths; never trust stored fields alone.
 */

import { createHash } from "node:crypto";
import {
  activationAttestationDigest,
  type CoverageActivationAttestation,
} from "./activation-attestation.js";
import { CursorProvenanceError } from "./errors.js";
import {
  computeCanonicalSemanticDigest,
  computeEventId,
  executionBindingDigest,
  executionWindowDigest,
  PROVENANCE_EVENT_SCHEMA_KIND,
  semanticPayloadForAgentAck,
  semanticPayloadForRunBound,
  type ProvenanceEvent,
} from "./events.js";
import { canonicalLaunchContextDigest } from "./launch-context.js";
import { deriveProvenanceEventPath } from "./paths.js";
import {
  reconciliationContradictsExistingEvidence,
  validateReconciliationStructural,
  type ReconciliationResolutionKind,
} from "./reconciliation.js";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export type CoverageIncompleteReason =
  | "coverage_activation_attestation_missing"
  | "coverage_attestation_interval_mismatch"
  | "coverage_attestation_mode_not_required"
  | "coverage_launch_surface_installation_incomplete"
  | "coverage_send_surface_installation_incomplete"
  | "coverage_workflow_installation_incomplete"
  | "coverage_runner_installation_incomplete"
  | "coverage_source_version_unsupported"
  | "coverage_runner_version_unsupported"
  | "coverage_activation_source_mismatch"
  | "coverage_event_snapshot_source_mismatch"
  | "coverage_activation_event_history_invalid"
  | "coverage_activation_commit_invalid"
  | "coverage_deployment_gap"
  | "coverage_writer_outage"
  | "coverage_event_snapshot_mismatch"
  | "coverage_event_history_not_closed"
  | "coverage_unresolved_launch_operation"
  | "coverage_unresolved_run_operation"
  | "coverage_event_divergence"
  | "coverage_reconciliation_evidence_invalid"
  | "coverage_launch_manifest_mismatch"
  | "coverage_send_manifest_mismatch"
  | "coverage_empty_source_allowlist"
  | "coverage_empty_runner_allowlist"
  | "coverage_attestation_duplicate_install"
  | "coverage_attestation_conflicting_install";

export interface EventSnapshotSourceIdentity {
  stateRepository: string;
  stateBranch: string;
  immutableCommitSha: string;
}

export interface ActivationSourceIdentityInput {
  stateRepository: string;
  stateBranch: string;
  activationRecordPath: string;
  activationCommitSha: string;
  attestationDigest: string;
}

export interface ProvenanceEventRecord {
  path: string;
  event: ProvenanceEvent;
}

export interface EventSnapshotValidationResult {
  ok: boolean;
  incompleteReasons: CoverageIncompleteReason[];
  divergenceEvidence: string[];
  recomputedEventSetDigest: string;
  activationAttestationDigest: string | null;
}

function addReason(
  set: Set<CoverageIncompleteReason>,
  reason: CoverageIncompleteReason,
): void {
  set.add(reason);
}

function addEvidence(set: Set<string>, evidence: string): void {
  set.add(evidence);
}

function semanticPayloadFromEvent(event: ProvenanceEvent): Record<string, unknown> {
  switch (event.eventType) {
    case "launch_intent":
      return { launchContextDigest: event.launchContextDigest };
    case "provider_call_started":
      return {};
    case "provider_agent_acknowledged":
      return semanticPayloadForAgentAck({
        agentHash: event.agentHash,
        envelope: event.agentIdEnvelope,
      });
    case "provider_run_intent":
    case "provider_run_call_started":
      return {
        providerRunOperationId: event.providerRunOperationId,
        sendSurface: event.sendSurface,
        sendOrdinal: event.sendOrdinal,
      };
    case "provider_run_bound":
      return {
        ...semanticPayloadForRunBound({
          agentHash: event.agentHash,
          runHash: event.runHash,
          executionBindingDigest: event.executionBindingDigest,
          executionWindow: {
            startInclusive: event.executionWindow.startInclusive,
            startEvidenceSource: event.executionWindow.startEvidenceSource,
            endExclusive: null,
            endEvidenceSource: null,
          },
          agentEnvelope: event.agentIdEnvelope,
          runEnvelope: event.runIdEnvelope,
          linearIssueKey: event.linearIssueKey,
          phase: event.phase,
          phaseExecutionId: event.phaseExecutionId,
          harnessRunId: event.harnessRunId,
          action: event.action,
          generation: event.generation,
        }),
        providerRunOperationId: event.providerRunOperationId,
        sendSurface: event.sendSurface,
        sendOrdinal: event.sendOrdinal,
      };
    case "execution_completed":
      return {
        providerRunOperationId: event.providerRunOperationId,
        sendSurface: event.sendSurface,
        sendOrdinal: event.sendOrdinal,
        agentHash: event.agentHash,
        runHash: event.runHash,
        terminalStatus: event.terminalStatus,
        executionWindow: event.executionWindow,
        executionWindowDigest: event.executionWindowDigest,
        completionEvidenceSource: event.completionEvidenceSource,
      };
    case "launch_failed":
      return {
        failureStage: event.failureStage,
        failureCategory: event.failureCategory,
      };
    case "reconciliation_resolution":
      return {
        resolutionId: event.resolutionId,
        affectedOperationId: event.affectedOperationId,
        affectedOperationKind: event.affectedOperationKind,
        authoritativeResolutionInstant: event.authoritativeResolutionInstant,
        resolutionKind: event.resolutionKind,
        evidenceSource: event.evidenceSource,
        evidenceDigest: event.evidenceDigest,
        producerSchemaVersion: event.producerSchemaVersion,
      };
    default:
      return {};
  }
}

function recomputeSemanticDigest(event: ProvenanceEvent): string {
  return computeCanonicalSemanticDigest({
    eventType: event.eventType,
    launchAttemptId: event.launchAttemptId,
    transitionId: event.transitionId,
    launchContextDigest: event.launchContextDigest,
    semanticPayload: semanticPayloadFromEvent(event),
  });
}

function validateBindingFields(event: ProvenanceEvent): string[] {
  if (event.eventType !== "provider_run_bound") {
    return [];
  }
  const evidence: string[] = [];
  const expectedBinding = executionBindingDigest({
    launchAttemptId: event.launchAttemptId,
    agentHash: event.agentHash,
    runHash: event.runHash,
    linearIssueKey: event.linearIssueKey,
    phase: event.phase,
    harnessRunId: event.harnessRunId,
    action: event.action,
    generation: event.generation,
  });
  if (expectedBinding !== event.executionBindingDigest) {
    evidence.push("execution_binding_digest_mismatch");
  }
  return evidence;
}

function validateCompletionFields(event: ProvenanceEvent): string[] {
  if (event.eventType !== "execution_completed") {
    return [];
  }
  const evidence: string[] = [];
  const expectedWindowDigest = executionWindowDigest(event.executionWindow);
  if (expectedWindowDigest !== event.executionWindowDigest) {
    evidence.push("execution_window_digest_mismatch");
  }
  return evidence;
}

/** Migration helper — prefer `records` in the final contract. */
export function eventRecordsFromParallelArrays(input: {
  events: ProvenanceEvent[];
  eventPaths: string[];
}): ProvenanceEventRecord[] {
  if (input.events.length !== input.eventPaths.length) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Event/path array length mismatch.",
    );
  }
  return input.events.map((event, index) => ({
    path: input.eventPaths[index]!,
    event,
  }));
}

export function validateEventSnapshot(input: {
  records: ProvenanceEventRecord[];
  eventSnapshotSource: EventSnapshotSourceIdentity;
  activationAttestation?: CoverageActivationAttestation | null;
  activationSource?: ActivationSourceIdentityInput | null;
}): EventSnapshotValidationResult {
  const incompleteReasons = new Set<CoverageIncompleteReason>();
  const divergenceEvidence = new Set<string>();

  const source = input.eventSnapshotSource;
  if (
    !source.stateRepository.trim() ||
    !source.stateBranch.trim() ||
    !COMMIT_SHA_RE.test(source.immutableCommitSha)
  ) {
    addReason(incompleteReasons, "coverage_event_snapshot_source_mismatch");
    addEvidence(divergenceEvidence, "invalid_event_snapshot_source");
  }

  if (input.activationSource && input.activationAttestation) {
    const attSource = input.activationAttestation.activationSource;
    const provided = input.activationSource;
    if (
      provided.stateRepository !== attSource.stateRepository ||
      provided.stateBranch !== attSource.stateBranch ||
      provided.activationRecordPath !== attSource.activationRecordPath ||
      provided.activationCommitSha !== attSource.activationCommitSha ||
      provided.attestationDigest !== attSource.attestationDigest
    ) {
      addReason(incompleteReasons, "coverage_activation_source_mismatch");
    }
    if (
      provided.stateRepository !== source.stateRepository ||
      provided.stateBranch !== source.stateBranch
    ) {
      addReason(incompleteReasons, "coverage_event_snapshot_source_mismatch");
    }
    if (!COMMIT_SHA_RE.test(provided.activationCommitSha)) {
      addReason(incompleteReasons, "coverage_activation_commit_invalid");
    }
  }

  let activationDigest: string | null = null;
  if (!input.activationAttestation) {
    addReason(incompleteReasons, "coverage_activation_attestation_missing");
  } else {
    try {
      activationDigest = activationAttestationDigest(input.activationAttestation);
    } catch {
      addReason(incompleteReasons, "coverage_attestation_conflicting_install");
    }
    const att = input.activationAttestation;
    if (att.requiredWriterMode !== "required") {
      addReason(incompleteReasons, "coverage_attestation_mode_not_required");
    }
    if (!COMMIT_SHA_RE.test(att.activationSource.activationCommitSha)) {
      addReason(incompleteReasons, "coverage_activation_commit_invalid");
    }
    if (
      att.stateRepository !== source.stateRepository ||
      att.stateBranch !== source.stateBranch
    ) {
      addReason(incompleteReasons, "coverage_event_snapshot_source_mismatch");
    }
  }

  const pathSet = new Set<string>();
  const eventIdSet = new Set<string>();
  const transitionSet = new Set<string>();
  const intentByAttempt = new Map<string, ProvenanceEvent>();
  const intentDigestByAttempt = new Map<string, string>();

  // Order-independent pre-index: later events may appear before launch_intent.
  for (const record of input.records) {
    const { event } = record;
    if (event.eventType !== "launch_intent") continue;
    if (intentByAttempt.has(event.launchAttemptId)) {
      addReason(incompleteReasons, "coverage_event_divergence");
      addEvidence(divergenceEvidence, "duplicate_launch_intent");
      continue;
    }
    intentByAttempt.set(event.launchAttemptId, event);
    intentDigestByAttempt.set(event.launchAttemptId, event.launchContextDigest);
  }

  const runOpToAttempt = new Map<string, string>();
  const runHashToOp = new Map<string, string>();
  const runOpsWithIntent = new Set<string>();
  const runOpsWithCall = new Set<string>();
  const runOpsWithBind = new Set<string>();
  const runOpsWithComplete = new Set<string>();
  const validatedPaths: string[] = [];
  const validatedDigests: string[] = [];

  for (const record of input.records) {
    const { path: suppliedPath, event } = record;

    if (event.schemaKind !== PROVENANCE_EVENT_SCHEMA_KIND) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, `schema:${event.eventType}`);
    }

    if (event.eventType === "launch_intent") {
      const recomputedCtx = canonicalLaunchContextDigest(event.launchContext);
      if (recomputedCtx !== event.launchContextDigest) {
        addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
        addEvidence(divergenceEvidence, "launch_context_digest_mismatch");
      }
    } else if (!intentDigestByAttempt.has(event.launchAttemptId)) {
      addReason(incompleteReasons, "coverage_event_history_not_closed");
      addEvidence(
        divergenceEvidence,
        `orphan_without_intent:${event.eventType}`,
      );
    }

    const authoritativeDigest =
      intentDigestByAttempt.get(event.launchAttemptId) ?? event.launchContextDigest;
    if (
      event.eventType !== "launch_intent" &&
      intentDigestByAttempt.has(event.launchAttemptId) &&
      event.launchContextDigest !== authoritativeDigest
    ) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, "launch_context_digest_mismatch");
    }

    const expectedEventId = computeEventId({
      launchAttemptId: event.launchAttemptId,
      transitionId: event.transitionId,
      eventType: event.eventType,
    });
    if (expectedEventId !== event.eventId) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, `event_id:${event.eventType}`);
    }

    const recomputedDigest = recomputeSemanticDigest(event);
    if (recomputedDigest !== event.canonicalSemanticDigest) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, `semantic_digest:${event.eventType}`);
    }

    for (const fieldEvidence of [
      ...validateBindingFields(event),
      ...validateCompletionFields(event),
    ]) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, fieldEvidence);
    }

    const derivedPath = deriveProvenanceEventPath(event);
    if (derivedPath !== suppliedPath) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, `path_mismatch:${event.eventType}`);
    }
    if (pathSet.has(suppliedPath)) {
      addReason(incompleteReasons, "coverage_event_divergence");
      addEvidence(divergenceEvidence, "duplicate_path");
    }
    pathSet.add(suppliedPath);

    if (eventIdSet.has(event.eventId)) {
      addReason(incompleteReasons, "coverage_event_divergence");
      addEvidence(divergenceEvidence, "duplicate_event_id");
    }
    eventIdSet.add(event.eventId);

    const transitionKey = `${event.launchAttemptId}:${event.transitionId}`;
    if (transitionSet.has(transitionKey)) {
      addReason(incompleteReasons, "coverage_event_divergence");
      addEvidence(divergenceEvidence, "duplicate_transition");
    }
    transitionSet.add(transitionKey);

    if (
      event.eventType === "provider_run_intent" ||
      event.eventType === "provider_run_call_started" ||
      event.eventType === "provider_run_bound" ||
      event.eventType === "execution_completed"
    ) {
      const runOp = event.providerRunOperationId;
      const priorAttempt = runOpToAttempt.get(runOp);
      if (priorAttempt && priorAttempt !== event.launchAttemptId) {
        addReason(incompleteReasons, "coverage_event_divergence");
        addEvidence(divergenceEvidence, "run_operation_spans_attempts");
      }
      runOpToAttempt.set(runOp, event.launchAttemptId);

      if (event.eventType === "provider_run_intent") {
        runOpsWithIntent.add(runOp);
      }
      if (event.eventType === "provider_run_call_started") {
        runOpsWithCall.add(runOp);
      }
      if (event.eventType === "provider_run_bound") {
        runOpsWithBind.add(runOp);
        const priorOp = runHashToOp.get(event.runHash);
        if (priorOp && priorOp !== runOp) {
          addReason(incompleteReasons, "coverage_event_divergence");
          addEvidence(divergenceEvidence, "run_hash_bound_multiple_ops");
        }
        runHashToOp.set(event.runHash, runOp);
      }
      if (event.eventType === "execution_completed") {
        runOpsWithComplete.add(runOp);
        const priorOp = runHashToOp.get(event.runHash);
        if (priorOp && priorOp !== runOp) {
          addReason(incompleteReasons, "coverage_event_divergence");
          addEvidence(divergenceEvidence, "run_hash_completed_multiple_ops");
        }
        runHashToOp.set(event.runHash, runOp);
      }
    }

    if (event.eventType === "reconciliation_resolution") {
      const structural = validateReconciliationStructural(event);
      if (structural) {
        addReason(incompleteReasons, structural);
      }
      if (!DIGEST_RE.test(event.evidenceDigest)) {
        addReason(incompleteReasons, "coverage_reconciliation_evidence_invalid");
      }
    }

    if (input.activationAttestation) {
      const att = input.activationAttestation;
      if (!att.sourceShaAllowlist.includes(event.sourceRepositorySha)) {
        addReason(incompleteReasons, "coverage_source_version_unsupported");
      }
      if (!att.runnerSnapshotVersionAllowlist.includes(event.runnerSnapshotVersion)) {
        addReason(incompleteReasons, "coverage_runner_version_unsupported");
      }
      if (event.writerVersion !== att.writerVersion) {
        addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
        addEvidence(divergenceEvidence, "writer_version_unauthorized");
      }
    }

    validatedPaths.push(derivedPath);
    validatedDigests.push(recomputedDigest);
  }

  for (const runOp of runOpsWithBind) {
    if (!runOpsWithIntent.has(runOp) || !runOpsWithCall.has(runOp)) {
      addReason(incompleteReasons, "coverage_event_history_not_closed");
      addEvidence(divergenceEvidence, `run_op_missing_pre_send:${runOp.slice(0, 12)}`);
    }
  }

  for (const runOp of runOpsWithComplete) {
    if (!runOpsWithBind.has(runOp)) {
      addReason(incompleteReasons, "coverage_event_snapshot_mismatch");
      addEvidence(divergenceEvidence, "completion_without_binding");
    }
    if (!runOpsWithIntent.has(runOp) || !runOpsWithCall.has(runOp)) {
      addReason(incompleteReasons, "coverage_event_history_not_closed");
      addEvidence(divergenceEvidence, `completion_missing_chain:${runOp.slice(0, 12)}`);
    }
  }

  for (const runOp of runOpsWithCall) {
    if (!runOpsWithIntent.has(runOp)) {
      addReason(incompleteReasons, "coverage_event_history_not_closed");
      addEvidence(divergenceEvidence, `call_without_intent:${runOp.slice(0, 12)}`);
    }
  }

  for (const [runHash, runOp] of runHashToOp) {
    if (runOpsWithComplete.has(runOp)) {
      continue;
    }
    if (runOpsWithBind.has(runOp)) {
      addReason(incompleteReasons, "coverage_event_history_not_closed");
      addEvidence(divergenceEvidence, `bound_without_completion:${runHash.slice(0, 12)}`);
    }
  }

  for (const record of input.records) {
    const event = record.event;
    if (event.eventType !== "reconciliation_resolution") {
      continue;
    }
    const kind = event.resolutionKind as ReconciliationResolutionKind;
    const launchCtx = {
      hasCallStarted: input.records.some(
        (r) =>
          r.event.launchAttemptId === event.launchAttemptId &&
          r.event.eventType === "provider_call_started",
      ),
      hasAgentAck: input.records.some(
        (r) =>
          r.event.launchAttemptId === event.launchAttemptId &&
          r.event.eventType === "provider_agent_acknowledged",
      ),
      hasRunIntent: input.records.some(
        (r) =>
          r.event.launchAttemptId === event.launchAttemptId &&
          r.event.eventType === "provider_run_intent",
      ),
      hasRunBound: input.records.some(
        (r) =>
          r.event.launchAttemptId === event.launchAttemptId &&
          r.event.eventType === "provider_run_bound",
      ),
      hasRunComplete: input.records.some(
        (r) =>
          r.event.launchAttemptId === event.launchAttemptId &&
          r.event.eventType === "execution_completed",
      ),
    };
    const runCtx =
      event.affectedOperationKind === "run_operation"
        ? {
            hasRunIntent: runOpsWithIntent.has(event.affectedOperationId),
            hasRunCallStarted: runOpsWithCall.has(event.affectedOperationId),
            hasRunBound: runOpsWithBind.has(event.affectedOperationId),
            hasRunComplete: runOpsWithComplete.has(event.affectedOperationId),
            activityStart:
              input.records.find(
                (r) =>
                  "providerRunOperationId" in r.event &&
                  r.event.providerRunOperationId === event.affectedOperationId,
              )?.event.recordedAt ?? null,
          }
        : null;

    if (
      reconciliationContradictsExistingEvidence({
        resolutionKind: kind,
        affectedOperationKind: event.affectedOperationKind,
        launch: launchCtx,
        run: runCtx,
      })
    ) {
      addReason(incompleteReasons, "coverage_reconciliation_evidence_invalid");
      addEvidence(divergenceEvidence, "reconciliation_contradicts_evidence");
    }
  }

  const sortedPaths = [...validatedPaths].sort();
  const sortedDigests = validatedDigests
    .map((digest, index) => ({ digest, path: validatedPaths[index]! }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((row) => row.digest);

  const recomputedEventSetDigest = createHash("sha256")
    .update(
      [
        source.stateRepository,
        source.stateBranch,
        source.immutableCommitSha,
        ...sortedPaths,
        ...sortedDigests,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

  const uniqueReasons = [...incompleteReasons].sort();
  return {
    ok: uniqueReasons.length === 0,
    incompleteReasons: uniqueReasons,
    divergenceEvidence: [...divergenceEvidence].sort(),
    recomputedEventSetDigest,
    activationAttestationDigest: activationDigest,
  };
}

export function assertEventSnapshotOrThrow(
  input: Parameters<typeof validateEventSnapshot>[0],
): EventSnapshotValidationResult {
  const result = validateEventSnapshot(input);
  if (
    result.divergenceEvidence.includes("duplicate_event_id") ||
    result.divergenceEvidence.includes("duplicate_path")
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Provenance event snapshot failed integrity validation.",
    );
  }
  return result;
}
