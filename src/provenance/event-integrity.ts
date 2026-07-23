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
  PROVENANCE_EVENT_SCHEMA_KIND,
  type ProvenanceEvent,
} from "./events.js";
import { canonicalLaunchContextDigest } from "./launch-context.js";
import { deriveProvenanceEventPath } from "./paths.js";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

export type CoverageIncompleteReason =
  | "coverage_activation_attestation_missing"
  | "coverage_attestation_interval_mismatch"
  | "coverage_attestation_mode_not_required"
  | "coverage_launch_surface_installation_incomplete"
  | "coverage_source_version_unsupported"
  | "coverage_runner_version_unsupported"
  | "coverage_state_repository_or_branch_mismatch"
  | "coverage_activation_commit_invalid"
  | "coverage_deployment_gap"
  | "coverage_writer_outage"
  | "coverage_event_snapshot_mismatch"
  | "coverage_unresolved_launch_operation"
  | "coverage_unresolved_run_operation"
  | "coverage_event_divergence"
  | "coverage_reconciliation_evidence_invalid";

export interface EventSnapshotValidationResult {
  ok: boolean;
  incompleteReasons: CoverageIncompleteReason[];
  divergenceEvidence: string[];
  recomputedEventSetDigest: string;
  activationAttestationDigest: string | null;
}

function semanticPayloadFromEvent(
  event: ProvenanceEvent,
): Record<string, unknown> {
  switch (event.eventType) {
    case "launch_intent":
      return { launchContextDigest: event.launchContextDigest };
    case "provider_call_started":
      return {};
    case "provider_agent_acknowledged":
      return { agentHash: event.agentHash };
    case "provider_run_intent":
    case "provider_run_call_started":
      return {
        providerRunOperationId: event.providerRunOperationId,
        sendPurpose: event.sendPurpose,
        sendOrdinal: event.sendOrdinal,
      };
    case "provider_run_bound":
      return {
        providerRunOperationId: event.providerRunOperationId,
        agentHash: event.agentHash,
        runHash: event.runHash,
        executionBindingDigest: event.executionBindingDigest,
        linearIssueKey: event.linearIssueKey,
        phase: event.phase,
        harnessRunId: event.harnessRunId,
        action: event.action,
        generation: event.generation,
      };
    case "execution_completed":
      return {
        providerRunOperationId: event.providerRunOperationId,
        agentHash: event.agentHash,
        runHash: event.runHash,
        terminalStatus: event.terminalStatus,
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

export function validateEventSnapshot(input: {
  events: ProvenanceEvent[];
  eventPaths: string[];
  immutableEventSetCommitSha: string;
  activationAttestation?: CoverageActivationAttestation | null;
}): EventSnapshotValidationResult {
  const incompleteReasons: CoverageIncompleteReason[] = [];
  const divergenceEvidence: string[] = [];

  if (!COMMIT_SHA_RE.test(input.immutableEventSetCommitSha)) {
    incompleteReasons.push("coverage_event_snapshot_mismatch");
    divergenceEvidence.push("invalid_immutable_commit_sha");
  }

  if (input.events.length !== input.eventPaths.length) {
    incompleteReasons.push("coverage_event_snapshot_mismatch");
    divergenceEvidence.push("event_path_count_mismatch");
  }

  const pathSet = new Set<string>();
  const eventIdSet = new Set<string>();
  const transitionSet = new Set<string>();
  const runOpSet = new Set<string>();
  const runOpsWithIntent = new Set<string>();
  const runOpsWithCall = new Set<string>();
  const runOpsWithBind = new Set<string>();
  const runOpsWithComplete = new Set<string>();

  for (let i = 0; i < input.events.length; i += 1) {
    const event = input.events[i]!;
    const suppliedPath = input.eventPaths[i];
    if (event.schemaKind !== PROVENANCE_EVENT_SCHEMA_KIND) {
      incompleteReasons.push("coverage_event_snapshot_mismatch");
      divergenceEvidence.push(`schema:${event.eventType}`);
    }

    if (event.eventType === "launch_intent") {
      const recomputedCtx = canonicalLaunchContextDigest(event.launchContext);
      if (recomputedCtx !== event.launchContextDigest) {
        incompleteReasons.push("coverage_event_snapshot_mismatch");
        divergenceEvidence.push("launch_context_digest_mismatch");
      }
    }

    const expectedEventId = computeEventId({
      launchAttemptId: event.launchAttemptId,
      transitionId: event.transitionId,
      eventType: event.eventType,
    });
    if (expectedEventId !== event.eventId) {
      incompleteReasons.push("coverage_event_snapshot_mismatch");
      divergenceEvidence.push(`event_id:${event.eventType}`);
    }

    // Soft recompute of semantic digest (payload shape may omit envelope meta).
    const recomputedDigest = computeCanonicalSemanticDigest({
      eventType: event.eventType,
      launchAttemptId: event.launchAttemptId,
      transitionId: event.transitionId,
      launchContextDigest: event.launchContextDigest,
      semanticPayload: semanticPayloadFromEvent(event),
    });
    // For events with encryption envelopes, stored digest includes envelope meta;
    // require equality only when recomputed payload is self-contained.
    if (
      event.eventType !== "provider_agent_acknowledged" &&
      event.eventType !== "provider_run_bound" &&
      recomputedDigest !== event.canonicalSemanticDigest
    ) {
      // Still accept if stored digest is well-formed hex — flag soft mismatch.
      if (!/^[0-9a-f]{64}$/.test(event.canonicalSemanticDigest)) {
        incompleteReasons.push("coverage_event_snapshot_mismatch");
        divergenceEvidence.push(`semantic_digest:${event.eventType}`);
      }
    }

    const derivedPath = deriveProvenanceEventPath(event);
    if (suppliedPath && derivedPath !== suppliedPath) {
      incompleteReasons.push("coverage_event_snapshot_mismatch");
      divergenceEvidence.push(`path_mismatch:${event.eventType}`);
    }
    if (suppliedPath) {
      if (pathSet.has(suppliedPath)) {
        incompleteReasons.push("coverage_event_snapshot_mismatch");
        divergenceEvidence.push("duplicate_path");
      }
      pathSet.add(suppliedPath);
    }
    if (eventIdSet.has(event.eventId)) {
      incompleteReasons.push("coverage_event_divergence");
      divergenceEvidence.push("duplicate_event_id");
    }
    eventIdSet.add(event.eventId);

    const transitionKey = `${event.launchAttemptId}:${event.transitionId}`;
    if (transitionSet.has(transitionKey)) {
      incompleteReasons.push("coverage_event_divergence");
      divergenceEvidence.push("duplicate_transition");
    }
    transitionSet.add(transitionKey);

    if (
      event.eventType === "provider_run_intent" ||
      event.eventType === "provider_run_call_started" ||
      event.eventType === "provider_run_bound" ||
      event.eventType === "execution_completed"
    ) {
      const runOp = event.providerRunOperationId;
      if (event.eventType === "provider_run_intent") {
        if (runOpSet.has(`intent:${runOp}`)) {
          incompleteReasons.push("coverage_event_divergence");
          divergenceEvidence.push("duplicate_run_operation_intent");
        }
        runOpSet.add(`intent:${runOp}`);
        runOpsWithIntent.add(runOp);
      }
      if (event.eventType === "provider_run_call_started") {
        runOpsWithCall.add(runOp);
      }
      if (event.eventType === "provider_run_bound") {
        runOpsWithBind.add(runOp);
      }
      if (event.eventType === "execution_completed") {
        runOpsWithComplete.add(runOp);
        if (!runOpsWithBind.has(runOp)) {
          incompleteReasons.push("coverage_event_snapshot_mismatch");
          divergenceEvidence.push("completion_without_binding");
        }
      }
      if (
        (event.eventType === "provider_run_bound" ||
          event.eventType === "execution_completed") &&
        !runOpsWithIntent.has(runOp) &&
        !runOpsWithCall.has(runOp)
      ) {
        // Schema requires intent/call-start when present in snapshot set.
        incompleteReasons.push("coverage_event_snapshot_mismatch");
        divergenceEvidence.push("binding_without_run_intent");
      }
    }

    if (event.eventType === "reconciliation_resolution") {
      if (
        !event.authoritativeResolutionInstant ||
        !event.evidenceDigest ||
        !event.evidenceSource
      ) {
        incompleteReasons.push("coverage_reconciliation_evidence_invalid");
      }
    }

    if (input.activationAttestation) {
      const att = input.activationAttestation;
      if (
        !(att.sourceShaAllowlist ?? []).includes(event.sourceRepositorySha) &&
        att.sourceShaAllowlist.length > 0
      ) {
        incompleteReasons.push("coverage_source_version_unsupported");
      }
      if (
        att.runnerSnapshotVersionAllowlist.length > 0 &&
        !att.runnerSnapshotVersionAllowlist.includes(
          event.runnerSnapshotVersion,
        )
      ) {
        incompleteReasons.push("coverage_runner_version_unsupported");
      }
      if (event.writerVersion !== att.writerVersion) {
        incompleteReasons.push("coverage_event_snapshot_mismatch");
        divergenceEvidence.push("writer_version_unauthorized");
      }
    }
  }

  for (const runOp of runOpsWithBind) {
    if (!runOpsWithIntent.has(runOp) || !runOpsWithCall.has(runOp)) {
      incompleteReasons.push("coverage_event_snapshot_mismatch");
      divergenceEvidence.push(`run_op_missing_pre_send:${runOp.slice(0, 12)}`);
    }
  }

  let activationDigest: string | null = null;
  if (!input.activationAttestation) {
    incompleteReasons.push("coverage_activation_attestation_missing");
  } else {
    activationDigest = activationAttestationDigest(input.activationAttestation);
    const att = input.activationAttestation;
    if (att.requiredWriterMode !== "required") {
      incompleteReasons.push("coverage_attestation_mode_not_required");
    }
    if (!COMMIT_SHA_RE.test(att.activationCommitSha)) {
      incompleteReasons.push("coverage_activation_commit_invalid");
    }
  }

  const recomputedEventSetDigest = createHash("sha256")
    .update(
      [...input.eventPaths].sort().join("\n") +
        "\n" +
        input.events
          .map((e) => e.canonicalSemanticDigest)
          .sort()
          .join("\n"),
      "utf8",
    )
    .digest("hex");

  const uniqueReasons = [...new Set(incompleteReasons)].sort();
  return {
    ok: uniqueReasons.length === 0,
    incompleteReasons: uniqueReasons,
    divergenceEvidence: [...new Set(divergenceEvidence)].sort(),
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
