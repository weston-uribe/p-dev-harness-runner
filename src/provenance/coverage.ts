import { createHash } from "node:crypto";
import {
  activationAttestationDigest,
  type CoverageActivationAttestation,
} from "./activation-attestation.js";
import type { ProvenanceEvent } from "./events.js";
import {
  assertEventSnapshotOrThrow,
  type CoverageIncompleteReason,
} from "./event-integrity.js";
import {
  launchSurfacesManifestDigest,
  PROVENANCE_WRITER_VERSION,
  LAUNCH_SURFACES_SCHEMA_KIND,
} from "./launch-surfaces.js";
import { LAUNCH_CONTEXT_SCHEMA_KIND } from "./launch-context.js";
import { PROVENANCE_EVENT_SCHEMA_KIND } from "./events.js";
import { CursorProvenanceError } from "./errors.js";

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
  activationAttestationDigest: string | null;
  sourceRepositoryVersions: string[];
  runnerSnapshotVersions: string[];
  immutableEventSetCommitSha: string;
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
  runAcknowledgmentWithoutBindingCount: number;
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
  hasRunAck: boolean;
  hasRunBound: boolean;
  completed: boolean;
  runHash: string | null;
  activityStart: string | null;
  activityEnd: string | null;
  unresolved: boolean;
  resolvedByReconciliation: boolean;
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
        hasRunAck: false,
        hasRunBound: false,
        completed: false,
        runHash: null,
        activityStart: null,
        activityEnd: null,
        unresolved: true,
        resolvedByReconciliation: false,
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
    // Unresolved activity stays open-ended — do not close via recordedAt.
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
        // Call-start without ack remains open-ended.
        bumpRunOpen(op, event.recordedAt);
        bumpOpen(row, event.recordedAt);
        break;
      }
      case "provider_run_bound": {
        const op = ensureRunOp(row, event.providerRunOperationId);
        op.hasRunAck = true;
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
        if (
          !event.authoritativeResolutionInstant ||
          !event.evidenceDigest ||
          !event.evidenceSource
        ) {
          break;
        }
        const instant = event.authoritativeResolutionInstant;
        if (event.affectedOperationKind === "run_operation") {
          const op = ensureRunOp(row, event.affectedOperationId);
          op.resolvedByReconciliation = true;
          op.unresolved = false;
          op.activityEnd = instant;
        } else if (event.affectedOperationId === row.launchAttemptId) {
          row.resolvedByReconciliation = true;
          bumpClosed(row, row.activityStart, instant);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const row of byAttempt.values()) {
    for (const op of row.runOperations) {
      if (op.resolvedByReconciliation) {
        op.unresolved = false;
        continue;
      }
      const missingCall = op.hasRunIntent && !op.hasRunCallStarted;
      const missingAck = op.hasRunCallStarted && !op.hasRunAck;
      const missingBind = op.hasRunAck && !op.hasRunBound;
      const incomplete = op.hasRunBound && !op.completed;
      op.unresolved = missingCall || missingAck || missingBind || incomplete ||
        (op.hasRunIntent && !op.completed && !op.resolvedByReconciliation);
      if (op.unresolved) {
        op.activityEnd = null;
      }
    }

    if (row.resolvedByReconciliation) {
      row.unresolved = false;
      continue;
    }

    const missingAck = row.hasCallStarted && !row.hasAgentAck;
    const missingBind = row.hasAgentAck && row.runBindings.length === 0 &&
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
  events: ProvenanceEvent[];
  eventPaths: string[];
  immutableEventSetCommitSha: string;
  reconciliationTimestamp?: string | null;
  supportedSourceVersions?: string[];
  supportedRunnerVersions?: string[];
  activationAttestation?: CoverageActivationAttestation | null;
}): CoverageSnapshot {
  const startMs = parseIso(input.interval.coverageStart);
  const endMs = parseIso(input.interval.coverageEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Coverage interval must be a closed half-open range with end > start.",
    );
  }

  const integrity = assertEventSnapshotOrThrow({
    events: input.events,
    eventPaths: input.eventPaths,
    immutableEventSetCommitSha: input.immutableEventSetCommitSha,
    activationAttestation: input.activationAttestation,
  });

  const incompleteReasons = new Set<CoverageIncompleteReason>(
    integrity.incompleteReasons,
  );

  const attempts = projectAttempts(input.events);
  const overlapping = attempts.filter((a) =>
    attemptOverlapsInterval(a, input.interval),
  );

  const overlappingRunOps = overlapping.flatMap((a) =>
    a.runOperations.filter((op) =>
      runOperationOverlapsInterval(op, input.interval),
    ),
  );

  const unresolvedIntentCount = overlapping.filter(
    (a) => a.hasIntent && !a.hasCallStarted && !a.resolvedByReconciliation,
  ).length;
  const providerCallWithoutAckCount = overlapping.filter(
    (a) => a.hasCallStarted && !a.hasAgentAck && !a.resolvedByReconciliation,
  ).length;
  const ackWithoutRunBindCount = overlapping.filter(
    (a) =>
      a.hasAgentAck &&
      a.runBindings.length === 0 &&
      a.runOperations.length === 0 &&
      !a.resolvedByReconciliation,
  ).length;
  const incompleteExecutionCount = overlapping.filter((a) =>
    a.runBindings.some((r) => !r.completed),
  ).length;

  const runIntentWithoutCallStartCount = overlappingRunOps.filter(
    (op) => op.hasRunIntent && !op.hasRunCallStarted && !op.resolvedByReconciliation,
  ).length;
  const runCallWithoutAcknowledgmentCount = overlappingRunOps.filter(
    (op) => op.hasRunCallStarted && !op.hasRunAck && !op.resolvedByReconciliation,
  ).length;
  const runAcknowledgmentWithoutBindingCount = overlappingRunOps.filter(
    (op) => op.hasRunAck && !op.hasRunBound && !op.resolvedByReconciliation,
  ).length;
  const runWithoutTerminalCompletionCount = overlappingRunOps.filter(
    (op) => op.hasRunBound && !op.completed && !op.resolvedByReconciliation,
  ).length;

  const stillOpenOverlaps = overlapping.some(
    (a) =>
      a.unresolved ||
      a.runOperations.some((r) => r.unresolved) ||
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

  const att = input.activationAttestation ?? null;
  // Never default observed versions to supported.
  const supportedSource = new Set(
    att?.sourceShaAllowlist ?? input.supportedSourceVersions ?? [],
  );
  const supportedRunner = new Set(
    att?.runnerSnapshotVersionAllowlist ??
      input.supportedRunnerVersions ??
      [],
  );
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

  if (!att) {
    incompleteReasons.add("coverage_activation_attestation_missing");
  } else {
    if (
      att.interval.coverageStart !== input.interval.coverageStart ||
      att.interval.coverageEnd !== input.interval.coverageEnd
    ) {
      incompleteReasons.add("coverage_attestation_interval_mismatch");
    }
    if (att.requiredWriterMode !== "required") {
      incompleteReasons.add("coverage_attestation_mode_not_required");
    }
    const expectedSurfaces = new Set(att.expectedProductionLaunchSurfaces);
    for (const surface of expectedSurfaces) {
      const install = att.surfaceInstallAttestations.find(
        (s) => s.surface === surface,
      );
      if (
        !install ||
        !intervalsOverlap(
          install.installedFrom,
          install.installedUntil,
          input.interval.coverageStart,
          input.interval.coverageEnd,
        ) ||
        (install.installedUntil !== null &&
          parseIso(install.installedUntil) <
            parseIso(input.interval.coverageEnd))
      ) {
        // Require install covering the full closed interval.
        const coversFull =
          install &&
          parseIso(install.installedFrom) <=
            parseIso(input.interval.coverageStart) &&
          (install.installedUntil === null ||
            parseIso(install.installedUntil) >=
              parseIso(input.interval.coverageEnd));
        if (!coversFull) {
          incompleteReasons.add(
            "coverage_launch_surface_installation_incomplete",
          );
        }
      }
    }
    if (mixedUnsupportedSourceVersions.length > 0) {
      incompleteReasons.add("coverage_source_version_unsupported");
    }
    if (mixedUnsupportedRunnerVersions.length > 0) {
      incompleteReasons.add("coverage_runner_version_unsupported");
    }
    if (supportedSource.size === 0 && sourceVersions.length > 0) {
      incompleteReasons.add("coverage_source_version_unsupported");
    }
    if (supportedRunner.size === 0 && runnerVersions.length > 0) {
      incompleteReasons.add("coverage_runner_version_unsupported");
    }
  }

  if (unresolvedIntentCount > 0 || providerCallWithoutAckCount > 0) {
    incompleteReasons.add("coverage_unresolved_launch_operation");
  }
  if (
    runIntentWithoutCallStartCount > 0 ||
    runCallWithoutAcknowledgmentCount > 0 ||
    runAcknowledgmentWithoutBindingCount > 0 ||
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

  // Empty event set without attestation is never complete.
  if (!att) {
    // already incomplete
  }

  const eventPathSet = [...input.eventPaths].sort();
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
    activationAttestationDigest: att ? activationAttestationDigest(att) : null,
    sourceRepositoryVersions: sourceVersions,
    runnerSnapshotVersions: runnerVersions,
    immutableEventSetCommitSha: input.immutableEventSetCommitSha,
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
    runAcknowledgmentWithoutBindingCount,
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

export interface CoverageEpochRecord {
  epochId: string;
  activatedAt: string;
  activationCommitSha: string;
  writerVersion: string;
  status: "active" | "closed_incomplete" | "invalidated";
  closedAt: string | null;
  reason: string | null;
}
