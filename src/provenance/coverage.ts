import { createHash } from "node:crypto";
import {
  activationAttestationDigest,
  validateActivationAttestationCompleteness,
  type ActivationSourceIdentity,
  type CoverageActivationAttestation,
} from "./activation-attestation.js";
import type { ProvenanceEvent } from "./events.js";
import {
  assertEventSnapshotOrThrow,
  eventRecordsFromParallelArrays,
  type ActivationSourceIdentityInput,
  type CoverageIncompleteReason,
  type EventSnapshotSourceIdentity,
  type ProvenanceEventRecord,
} from "./event-integrity.js";
import {
  launchSurfacesManifestDigest,
  PROVENANCE_WRITER_VERSION,
  LAUNCH_SURFACES_SCHEMA_KIND,
  SEND_SURFACES_SCHEMA_KIND,
  sendSurfacesManifestDigest,
} from "./launch-surfaces.js";
import { LAUNCH_CONTEXT_SCHEMA_KIND } from "./launch-context.js";
import { PROVENANCE_EVENT_SCHEMA_KIND } from "./events.js";
import { CursorProvenanceError } from "./errors.js";
import {
  reconciliationClosesActivity,
  validateReconciliationStructural,
  type ReconciliationResolutionKind,
} from "./reconciliation.js";

export const COVERAGE_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-registry-coverage.v1" as const;

export type CoverageStatus = "complete" | "incomplete";

export interface CoverageInterval {
  /** Inclusive start. */
  coverageStart: string;
  /** Exclusive end. Never open-ended. */
  coverageEnd: string;
}

export interface CoverageSnapshot {
  kind: typeof COVERAGE_SCHEMA_KIND;
  version: "1";
  interval: CoverageInterval;
  status: CoverageStatus;
  incompleteReasons: CoverageIncompleteReason[];
  writerVersion: string;
  contextSchemaKind: string;
  provenanceSchemaKind: string;
  launchSurfacesSchemaKind: string;
  launchSurfacesManifestVersion: string;
  launchSurfacesManifestDigest: string;
  sendSurfacesSchemaKind: string;
  sendSurfacesManifestVersion: string;
  sendSurfacesManifestDigest: string;
  activationAttestationDigest: string | null;
  activationSource: ActivationSourceIdentity | null;
  eventSnapshotSource: EventSnapshotSourceIdentity;
  sourceRepositoryVersions: string[];
  runnerSnapshotVersions: string[];
  eventPathSet: string[];
  eventSetDigest: string;
  launchAttemptCount: number;
  acknowledgedAgentCount: number;
  runBindingCount: number;
  completedRunCount: number;
  unresolvedIntentCount: number;
  providerCallWithoutAckCount: number;
  ackWithoutRunBindCount: number;
  incompleteExecutionCount: number;
  runIntentWithoutCallStartCount: number;
  runCallWithoutAcknowledgmentCount: number;
  runWithoutTerminalCompletionCount: number;
  writerDeploymentGaps: string[];
  mixedUnsupportedRunnerVersions: string[];
  mixedUnsupportedSourceVersions: string[];
  duplicateDivergenceEvidence: string[];
  reconciliationTimestamp: string | null;
  coverageDigest: string;
}

export interface RunOperationProjection {
  providerRunOperationId: string;
  hasRunIntent: boolean;
  hasRunCallStarted: boolean;
  hasRunBound: boolean;
  completed: boolean;
  runHash: string | null;
  activityStart: string | null;
  activityEnd: string | null;
  unresolved: boolean;
  resolvedByReconciliation: boolean;
  permanentlyUnresolvable: boolean;
}

export interface AttemptProjection {
  launchAttemptId: string;
  hasIntent: boolean;
  hasCallStarted: boolean;
  hasAgentAck: boolean;
  runBindings: Array<{
    runHash: string;
    providerRunOperationId: string | null;
    startInclusive: string;
    endExclusive: string | null;
    completed: boolean;
  }>;
  runOperations: RunOperationProjection[];
  launchFailedStages: string[];
  sourceRepositorySha: string | null;
  runnerSnapshotVersion: string | null;
  /** Earliest known possible-activity instant for overlap. */
  activityStart: string | null;
  /** Latest closed activity instant; null if still open-ended. */
  activityEnd: string | null;
  unresolved: boolean;
  resolvedByReconciliation: boolean;
  permanentlyUnresolvable: boolean;
}

function parseIso(value: string): number {
  return Date.parse(value);
}

/** Half-open overlap: [aStart, aEnd) overlaps [bStart, bEnd). */
export function intervalsOverlap(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string,
): boolean {
  const as = parseIso(aStart);
  const ae = aEnd === null ? Number.POSITIVE_INFINITY : parseIso(aEnd);
  const bs = parseIso(bStart);
  const be = parseIso(bEnd);
  if (![as, ae, bs, be].every(Number.isFinite) && aEnd !== null) {
    return true;
  }
  return as < be && ae > bs;
}

export function projectAttempts(events: ProvenanceEvent[]): AttemptProjection[] {
  const byAttempt = new Map<string, AttemptProjection>();

  const ensure = (id: string): AttemptProjection => {
    let row = byAttempt.get(id);
    if (!row) {
      row = {
        launchAttemptId: id,
        hasIntent: false,
        hasCallStarted: false,
        hasAgentAck: false,
        runBindings: [],
        runOperations: [],
        launchFailedStages: [],
        sourceRepositorySha: null,
        runnerSnapshotVersion: null,
        activityStart: null,
        activityEnd: null,
        unresolved: true,
        resolvedByReconciliation: false,
        permanentlyUnresolvable: false,
      };
      byAttempt.set(id, row);
    }
    return row;
  };

  const ensureRunOp = (
    row: AttemptProjection,
    runOpId: string,
  ): RunOperationProjection => {
    let op = row.runOperations.find((r) => r.providerRunOperationId === runOpId);
    if (!op) {
      op = {
        providerRunOperationId: runOpId,
        hasRunIntent: false,
        hasRunCallStarted: false,
        hasRunBound: false,
        completed: false,
        runHash: null,
        activityStart: null,
        activityEnd: null,
        unresolved: true,
        resolvedByReconciliation: false,
        permanentlyUnresolvable: false,
      };
      row.runOperations.push(op);
    }
    return op;
  };

  const bumpOpen = (row: AttemptProjection, start: string | null) => {
    if (!start) return;
    if (!row.activityStart || parseIso(start) < parseIso(row.activityStart)) {
      row.activityStart = start;
    }
    row.activityEnd = null;
  };

  const bumpClosed = (
    row: AttemptProjection,
    start: string | null,
    end: string | null,
  ) => {
    if (start) {
      if (!row.activityStart || parseIso(start) < parseIso(row.activityStart)) {
        row.activityStart = start;
      }
    }
    if (end) {
      if (!row.activityEnd || parseIso(end) > parseIso(row.activityEnd)) {
        row.activityEnd = end;
      }
    }
  };

  const bumpRunOpen = (op: RunOperationProjection, start: string | null) => {
    if (!start) return;
    if (!op.activityStart || parseIso(start) < parseIso(op.activityStart)) {
      op.activityStart = start;
    }
    op.activityEnd = null;
  };

  for (const event of events) {
    const row = ensure(event.launchAttemptId);
    row.sourceRepositorySha = event.sourceRepositorySha;
    row.runnerSnapshotVersion = event.runnerSnapshotVersion;

    switch (event.eventType) {
      case "launch_intent":
        row.hasIntent = true;
        bumpOpen(row, event.recordedAt);
        break;
      case "provider_call_started":
        row.hasCallStarted = true;
        bumpOpen(row, event.recordedAt);
        break;
      case "provider_agent_acknowledged":
        row.hasAgentAck = true;
        bumpOpen(row, event.recordedAt);
        break;
      case "provider_run_intent": {
        const op = ensureRunOp(row, event.providerRunOperationId);
        op.hasRunIntent = true;
        bumpRunOpen(op, event.recordedAt);
        bumpOpen(row, event.recordedAt);
        break;
      }
      case "provider_run_call_started": {
        const op = ensureRunOp(row, event.providerRunOperationId);
        op.hasRunCallStarted = true;
        bumpRunOpen(op, event.recordedAt);
        bumpOpen(row, event.recordedAt);
        break;
      }
      case "provider_run_bound": {
        const op = ensureRunOp(row, event.providerRunOperationId);
        op.hasRunBound = true;
        op.runHash = event.runHash;
        const existing = row.runBindings.find((r) => r.runHash === event.runHash);
        if (!existing) {
          row.runBindings.push({
            runHash: event.runHash,
            providerRunOperationId: event.providerRunOperationId,
            startInclusive: event.executionWindow.startInclusive,
            endExclusive: event.executionWindow.endExclusive,
            completed: false,
          });
        }
        bumpRunOpen(op, event.executionWindow.startInclusive);
        bumpOpen(row, event.executionWindow.startInclusive);
        break;
      }
      case "execution_completed": {
        const op = ensureRunOp(row, event.providerRunOperationId);
        op.hasRunBound = true;
        op.completed = true;
        op.runHash = event.runHash;
        op.activityStart = event.executionWindow.startInclusive;
        op.activityEnd = event.executionWindow.endExclusive;
        let binding = row.runBindings.find((r) => r.runHash === event.runHash);
        if (!binding) {
          binding = {
            runHash: event.runHash,
            providerRunOperationId: event.providerRunOperationId,
            startInclusive: event.executionWindow.startInclusive,
            endExclusive: event.executionWindow.endExclusive,
            completed: true,
          };
          row.runBindings.push(binding);
        } else {
          binding.endExclusive = event.executionWindow.endExclusive;
          binding.completed = true;
        }
        bumpClosed(
          row,
          event.executionWindow.startInclusive,
          event.executionWindow.endExclusive,
        );
        break;
      }
      case "launch_failed":
        row.launchFailedStages.push(event.failureStage);
        bumpOpen(row, event.recordedAt);
        break;
      case "reconciliation_resolution": {
        if (validateReconciliationStructural(event)) {
          break;
        }
        const kind = event.resolutionKind as ReconciliationResolutionKind;
        if (kind === "operation_permanently_unresolvable") {
          if (event.affectedOperationKind === "run_operation") {
            const op = ensureRunOp(row, event.affectedOperationId);
            op.permanentlyUnresolvable = true;
          } else if (event.affectedOperationId === row.launchAttemptId) {
            row.permanentlyUnresolvable = true;
          }
          break;
        }

        const launchCtx = {
          hasCallStarted: row.hasCallStarted,
          hasAgentAck: row.hasAgentAck,
          hasRunIntent: row.runOperations.some((op) => op.hasRunIntent),
          hasRunBound: row.runBindings.length > 0,
          hasRunComplete: row.runOperations.some((op) => op.completed),
        };

        if (event.affectedOperationKind === "run_operation") {
          const op = ensureRunOp(row, event.affectedOperationId);
          const runCtx = {
            hasRunIntent: op.hasRunIntent,
            hasRunCallStarted: op.hasRunCallStarted,
            hasRunBound: op.hasRunBound,
            hasRunComplete: op.completed,
            activityStart: op.activityStart,
          };
          if (
            reconciliationClosesActivity({
              resolutionKind: kind,
              affectedOperationKind: "run_operation",
              launch: launchCtx,
              run: runCtx,
              authoritativeResolutionInstant:
                event.authoritativeResolutionInstant,
            })
          ) {
            if (kind === "provider_run_binding_recovered") {
              op.hasRunBound = true;
            }
            if (kind === "provider_terminal_window_recovered") {
              op.hasRunBound = true;
              op.completed = true;
              op.activityEnd = event.authoritativeResolutionInstant;
            }
            if (kind === "provider_mutation_proven_not_started") {
              op.unresolved = false;
              op.activityEnd = event.authoritativeResolutionInstant;
            }
            op.resolvedByReconciliation = true;
          }
        } else if (event.affectedOperationId === row.launchAttemptId) {
          if (
            reconciliationClosesActivity({
              resolutionKind: kind,
              affectedOperationKind: "launch_attempt",
              launch: launchCtx,
              run: null,
              authoritativeResolutionInstant:
                event.authoritativeResolutionInstant,
            })
          ) {
            if (kind === "provider_agent_ack_recovered") {
              row.hasAgentAck = true;
            }
            row.resolvedByReconciliation = true;
            bumpClosed(
              row,
              row.activityStart,
              event.authoritativeResolutionInstant,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }

  for (const row of byAttempt.values()) {
    for (const op of row.runOperations) {
      if (op.permanentlyUnresolvable) {
        op.unresolved = true;
        op.activityEnd = null;
        continue;
      }
      if (op.resolvedByReconciliation && op.completed) {
        op.unresolved = false;
        continue;
      }
      if (op.resolvedByReconciliation && op.hasRunBound && !op.completed) {
        op.unresolved = true;
        op.activityEnd = null;
        continue;
      }
      if (op.resolvedByReconciliation && !op.hasRunBound) {
        op.unresolved = false;
        continue;
      }

      const missingCall = op.hasRunIntent && !op.hasRunCallStarted;
      const missingBind = op.hasRunCallStarted && !op.hasRunBound;
      const incomplete = op.hasRunBound && !op.completed;
      op.unresolved =
        missingCall ||
        missingBind ||
        incomplete ||
        (op.hasRunIntent && !op.completed);
      if (op.unresolved) {
        op.activityEnd = null;
      }
    }

    if (row.permanentlyUnresolvable) {
      row.unresolved = true;
      row.activityEnd = null;
      continue;
    }

    if (row.resolvedByReconciliation) {
      const unresolvedRunOp = row.runOperations.some((r) => r.unresolved);
      row.unresolved = unresolvedRunOp;
      if (!row.unresolved && row.activityEnd === null && row.runBindings.length === 0) {
        // launch-level reconciliation closed without run activity.
        row.unresolved = false;
      }
      continue;
    }

    const missingAck = row.hasCallStarted && !row.hasAgentAck;
    const missingBind =
      row.hasAgentAck &&
      row.runBindings.length === 0 &&
      row.runOperations.length === 0;
    const incompleteRun = row.runBindings.some((r) => !r.completed);
    const missingCall = row.hasIntent && !row.hasCallStarted;
    const unresolvedRunOp = row.runOperations.some((r) => r.unresolved);
    row.unresolved =
      missingCall ||
      missingAck ||
      missingBind ||
      incompleteRun ||
      unresolvedRunOp;

    if (row.unresolved) {
      row.activityEnd = null;
    } else if (
      row.runBindings.length > 0 &&
      row.runBindings.every((r) => r.completed && r.endExclusive)
    ) {
      const ends = row.runBindings
        .map((r) => r.endExclusive)
        .filter((e): e is string => Boolean(e));
      if (ends.length > 0) {
        row.activityEnd = ends.reduce((a, b) =>
          parseIso(a) > parseIso(b) ? a : b,
        );
      }
    }
  }

  return [...byAttempt.values()];
}

export function attemptOverlapsInterval(
  attempt: AttemptProjection,
  interval: CoverageInterval,
): boolean {
  const start = attempt.activityStart ?? interval.coverageStart;
  const end = attempt.unresolved ? null : attempt.activityEnd;
  if (!attempt.activityStart && !attempt.unresolved) {
    return false;
  }
  return intervalsOverlap(
    start,
    end,
    interval.coverageStart,
    interval.coverageEnd,
  );
}

export function runOperationOverlapsInterval(
  op: RunOperationProjection,
  interval: CoverageInterval,
): boolean {
  if (!op.activityStart && !op.unresolved) {
    return false;
  }
  const start = op.activityStart ?? interval.coverageStart;
  const end = op.unresolved ? null : op.activityEnd;
  return intervalsOverlap(start, end, interval.coverageStart, interval.coverageEnd);
}

export function buildCoverageSnapshot(input: {
  interval: CoverageInterval;
  records: ProvenanceEventRecord[];
  eventSnapshotSource: EventSnapshotSourceIdentity;
  activationSource?: ActivationSourceIdentityInput | null;
  activationAttestation?: CoverageActivationAttestation | null;
  reconciliationTimestamp?: string | null;
  eventCommitDescendedFromActivation?: boolean;
}): CoverageSnapshot {
  const startMs = parseIso(input.interval.coverageStart);
  const endMs = parseIso(input.interval.coverageEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Coverage interval must be a closed half-open range with end > start.",
    );
  }

  const events = input.records.map((record) => record.event);
  const eventPaths = input.records.map((record) => record.path);

  const integrity = assertEventSnapshotOrThrow({
    records: input.records,
    eventSnapshotSource: input.eventSnapshotSource,
    activationAttestation: input.activationAttestation,
    activationSource: input.activationSource,
  });

  const incompleteReasons = new Set<CoverageIncompleteReason>(
    integrity.incompleteReasons,
  );

  const att = input.activationAttestation ?? null;
  if (!att) {
    incompleteReasons.add("coverage_activation_attestation_missing");
  } else {
    for (const reason of validateActivationAttestationCompleteness(
      att,
      input.interval,
    )) {
      incompleteReasons.add(reason);
    }

    if (input.activationSource) {
      const pinned = att.activationSource;
      const provided = input.activationSource;
      if (
        provided.stateRepository !== pinned.stateRepository ||
        provided.stateBranch !== pinned.stateBranch ||
        provided.activationRecordPath !== pinned.activationRecordPath ||
        provided.activationCommitSha !== pinned.activationCommitSha ||
        provided.attestationDigest !== pinned.attestationDigest
      ) {
        incompleteReasons.add("coverage_activation_source_mismatch");
      }
    }

    if (
      att.stateRepository !== input.eventSnapshotSource.stateRepository ||
      att.stateBranch !== input.eventSnapshotSource.stateBranch
    ) {
      incompleteReasons.add("coverage_event_snapshot_source_mismatch");
    }
  }

  if (input.eventCommitDescendedFromActivation === false) {
    incompleteReasons.add("coverage_activation_event_history_invalid");
  }

  const attempts = projectAttempts(events);
  const overlapping = attempts.filter((a) =>
    attemptOverlapsInterval(a, input.interval),
  );

  const overlappingRunOps = overlapping.flatMap((a) =>
    a.runOperations.filter((op) =>
      runOperationOverlapsInterval(op, input.interval),
    ),
  );

  const unresolvedIntentCount = overlapping.filter(
    (a) => a.hasIntent && !a.hasCallStarted && !a.resolvedByReconciliation && !a.permanentlyUnresolvable,
  ).length;
  const providerCallWithoutAckCount = overlapping.filter(
    (a) => a.hasCallStarted && !a.hasAgentAck && !a.resolvedByReconciliation && !a.permanentlyUnresolvable,
  ).length;
  const ackWithoutRunBindCount = overlapping.filter(
    (a) =>
      a.hasAgentAck &&
      a.runBindings.length === 0 &&
      a.runOperations.length === 0 &&
      !a.resolvedByReconciliation &&
      !a.permanentlyUnresolvable,
  ).length;
  const incompleteExecutionCount = overlapping.filter((a) =>
    a.runBindings.some((r) => !r.completed),
  ).length;

  const runIntentWithoutCallStartCount = overlappingRunOps.filter(
    (op) => op.hasRunIntent && !op.hasRunCallStarted && !op.resolvedByReconciliation && !op.permanentlyUnresolvable,
  ).length;
  const runCallWithoutAcknowledgmentCount = overlappingRunOps.filter(
    (op) => op.hasRunCallStarted && !op.hasRunBound && !op.resolvedByReconciliation && !op.permanentlyUnresolvable,
  ).length;
  const runWithoutTerminalCompletionCount = overlappingRunOps.filter(
    (op) => op.hasRunBound && !op.completed && !op.resolvedByReconciliation && !op.permanentlyUnresolvable,
  ).length;

  const stillOpenOverlaps =
    overlapping.some(
      (a) =>
        a.unresolved ||
        a.permanentlyUnresolvable ||
        a.runOperations.some((r) => r.unresolved || r.permanentlyUnresolvable) ||
        a.runBindings.some((r) => r.endExclusive === null),
    );

  const sourceVersions = [
    ...new Set(
      overlapping
        .map((a) => a.sourceRepositorySha)
        .filter((v): v is string => Boolean(v)),
    ),
  ].sort();
  const runnerVersions = [
    ...new Set(
      overlapping
        .map((a) => a.runnerSnapshotVersion)
        .filter((v): v is string => Boolean(v)),
    ),
  ].sort();

  const supportedSource = new Set(att?.sourceShaAllowlist ?? []);
  const supportedRunner = new Set(att?.runnerSnapshotVersionAllowlist ?? []);
  const mixedUnsupportedSourceVersions = sourceVersions.filter(
    (v) => supportedSource.size > 0 && !supportedSource.has(v),
  );
  const mixedUnsupportedRunnerVersions = runnerVersions.filter(
    (v) => supportedRunner.size > 0 && !supportedRunner.has(v),
  );

  const writerDeploymentGaps: string[] = [];
  if (stillOpenOverlaps) {
    writerDeploymentGaps.push("overlapping_execution_not_terminal");
  }
  if (att?.knownWriterOutagesOrGaps?.length) {
    for (const gap of att.knownWriterOutagesOrGaps) {
      if (
        intervalsOverlap(
          gap.from,
          gap.until,
          input.interval.coverageStart,
          input.interval.coverageEnd,
        )
      ) {
        writerDeploymentGaps.push(`writer_outage:${gap.reason}`);
        incompleteReasons.add("coverage_writer_outage");
        incompleteReasons.add("coverage_deployment_gap");
      }
    }
  }

  if (mixedUnsupportedSourceVersions.length > 0) {
    incompleteReasons.add("coverage_source_version_unsupported");
  }
  if (mixedUnsupportedRunnerVersions.length > 0) {
    incompleteReasons.add("coverage_runner_version_unsupported");
  }

  if (unresolvedIntentCount > 0 || providerCallWithoutAckCount > 0) {
    incompleteReasons.add("coverage_unresolved_launch_operation");
  }
  if (
    runIntentWithoutCallStartCount > 0 ||
    runCallWithoutAcknowledgmentCount > 0 ||
    runWithoutTerminalCompletionCount > 0 ||
    incompleteExecutionCount > 0 ||
    stillOpenOverlaps
  ) {
    incompleteReasons.add("coverage_unresolved_run_operation");
  }
  if (integrity.divergenceEvidence.length > 0) {
    incompleteReasons.add("coverage_event_divergence");
  }

  const reasons = [...incompleteReasons].sort();
  const status: CoverageStatus =
    reasons.length === 0 && att ? "complete" : "incomplete";

  const eventPathSet = [...eventPaths].sort();
  const activationSourcePinned = att?.activationSource ?? input.activationSource ?? null;

  const partial: Omit<CoverageSnapshot, "coverageDigest"> = {
    kind: COVERAGE_SCHEMA_KIND,
    version: "1",
    interval: input.interval,
    status,
    incompleteReasons: reasons,
    writerVersion: PROVENANCE_WRITER_VERSION,
    contextSchemaKind: LAUNCH_CONTEXT_SCHEMA_KIND,
    provenanceSchemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    launchSurfacesSchemaKind: LAUNCH_SURFACES_SCHEMA_KIND,
    launchSurfacesManifestVersion: "1",
    launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
    sendSurfacesSchemaKind: SEND_SURFACES_SCHEMA_KIND,
    sendSurfacesManifestVersion: "1",
    sendSurfacesManifestDigest: sendSurfacesManifestDigest(),
    activationAttestationDigest: att ? activationAttestationDigest(att) : null,
    activationSource: activationSourcePinned,
    eventSnapshotSource: input.eventSnapshotSource,
    sourceRepositoryVersions: sourceVersions,
    runnerSnapshotVersions: runnerVersions,
    eventPathSet,
    eventSetDigest: integrity.recomputedEventSetDigest,
    launchAttemptCount: overlapping.length,
    acknowledgedAgentCount: overlapping.filter((a) => a.hasAgentAck).length,
    runBindingCount: overlapping.reduce((n, a) => n + a.runBindings.length, 0),
    completedRunCount: overlapping.reduce(
      (n, a) => n + a.runBindings.filter((r) => r.completed).length,
      0,
    ),
    unresolvedIntentCount,
    providerCallWithoutAckCount,
    ackWithoutRunBindCount,
    incompleteExecutionCount,
    runIntentWithoutCallStartCount,
    runCallWithoutAcknowledgmentCount,
    runWithoutTerminalCompletionCount,
    writerDeploymentGaps: [...writerDeploymentGaps].sort(),
    mixedUnsupportedRunnerVersions,
    mixedUnsupportedSourceVersions,
    duplicateDivergenceEvidence: integrity.divergenceEvidence,
    reconciliationTimestamp: input.reconciliationTimestamp ?? null,
  };

  const coverageDigest = createHash("sha256")
    .update(JSON.stringify(partial), "utf8")
    .digest("hex");

  return { ...partial, coverageDigest };
}

/** Migration helper for callers still using parallel arrays. */
export function buildCoverageSnapshotFromLegacy(input: {
  interval: CoverageInterval;
  events: ProvenanceEvent[];
  eventPaths: string[];
  immutableEventSetCommitSha: string;
  stateRepository?: string;
  stateBranch?: string;
  reconciliationTimestamp?: string | null;
  activationAttestation?: CoverageActivationAttestation | null;
  activationSource?: ActivationSourceIdentityInput | null;
  eventCommitDescendedFromActivation?: boolean;
}): CoverageSnapshot {
  return buildCoverageSnapshot({
    interval: input.interval,
    records: eventRecordsFromParallelArrays({
      events: input.events,
      eventPaths: input.eventPaths,
    }),
    eventSnapshotSource: {
      stateRepository: input.stateRepository ?? "",
      stateBranch: input.stateBranch ?? "",
      immutableCommitSha: input.immutableEventSetCommitSha,
    },
    activationAttestation: input.activationAttestation,
    activationSource: input.activationSource,
    reconciliationTimestamp: input.reconciliationTimestamp,
    eventCommitDescendedFromActivation: input.eventCommitDescendedFromActivation,
  });
}

export interface CoverageEpochRecord {
  epochId: string;
  activatedAt: string;
  activationCommitSha: string;
  writerVersion: string;
  status: "active" | "closed_incomplete" | "invalidated";
  closedAt: string | null;
  reason: string | null;
}
