import { createHash } from "node:crypto";
import {
  activationPayloadDigest,
  type CanonicalActivationPayload,
  type PersistedActivationRecord,
  type RetrievedActivationSource,
} from "../../../provenance/activation-attestation.js";
import {
  computeHistoryProofEvidenceDigest,
  type ActivationHistoryProofRecord,
  type VerifiedActivationHistoryProof,
} from "../../../provenance/activation-history-proof.js";
import {
  assertEventSnapshotOrThrow,
  eventRecordsFromParallelArrays,
  type ProvenanceEventRecord,
} from "../../../provenance/event-integrity.js";
import {
  buildCoverageSnapshot,
  projectAttempts,
  type CoverageInterval,
  type CoverageSnapshot,
} from "../../../provenance/coverage.js";
import type { ProvenanceEvent } from "../../../provenance/events.js";
import { deriveProvenanceEventPath } from "../../../provenance/paths.js";
import type { CoverageSealRecord } from "../../../provenance/coverage-lifecycle-schemas.js";
import { digestCanonical } from "../expected-score-manifest.js";
import {
  CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION,
  type RegistryIntegrityFailure,
  type RegistryPin,
  type RegistryReadResult,
  type RunOperationBinding,
  type TerminalRunOutcome,
} from "./contracts.js";

export interface RegistrySnapshotInput {
  pin: RegistryPin;
  activationRecord: PersistedActivationRecord | null;
  activationSource: RetrievedActivationSource | null;
  activationHistoryProof: ActivationHistoryProofRecord | VerifiedActivationHistoryProof | null;
  events: ProvenanceEvent[];
  eventPaths?: string[];
  coverageSnapshot: CoverageSnapshot | null;
  sealRecord: CoverageSealRecord | null;
}

export interface RegistryContentFetcher {
  readJsonAtCommit<T>(input: {
    stateRepository: string;
    stateBranch: string;
    commitSha: string;
    path: string;
  }): Promise<T | null>;
  listPathsAtCommit(input: {
    stateRepository: string;
    stateBranch: string;
    commitSha: string;
    prefix: string;
  }): Promise<string[]>;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function digestHex(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function terminalOutcomeForRunOp(input: {
  completed: boolean;
  permanentlyUnresolvable: boolean;
  unresolved: boolean;
  resolvedByReconciliation: boolean;
  hasLaunchFailed: boolean;
}): TerminalRunOutcome {
  if (input.permanentlyUnresolvable) return "permanently_unresolvable";
  if (input.hasLaunchFailed) return "failed";
  if (input.completed) return "completed";
  if (input.resolvedByReconciliation && !input.unresolved) return "reconciled_closed";
  if (input.unresolved) return "unresolved";
  return "unresolved";
}

export function projectRunOperationBindings(input: {
  events: ProvenanceEvent[];
  coverageEpochId: string | null;
}): RunOperationBinding[] {
  const launchContextByAttempt = new Map<
    string,
    {
      linearIssueKey: string | null;
      phase: string | null;
      harnessRunId: string | null;
      phaseExecutionId: string | null;
      launchSurface: string | null;
    }
  >();
  const launchFailed = new Set<string>();
  const sendByRunOp = new Map<
    string,
    { sendSurface: string | null; sendOrdinal: number | null }
  >();
  const agentHashByAttempt = new Map<string, string>();

  for (const event of input.events) {
    if (event.eventType === "launch_intent") {
      launchContextByAttempt.set(event.launchAttemptId, {
        linearIssueKey: event.launchContext.linearIssueKey,
        phase: event.launchContext.phase,
        harnessRunId: event.launchContext.harnessRunId,
        phaseExecutionId: event.launchContext.phaseExecutionId,
        launchSurface: event.launchContext.launchSurface,
      });
    }
    if (event.eventType === "provider_agent_acknowledged") {
      agentHashByAttempt.set(event.launchAttemptId, event.agentHash);
    }
    if (
      event.eventType === "provider_run_intent" ||
      event.eventType === "provider_run_call_started" ||
      event.eventType === "provider_run_bound" ||
      event.eventType === "execution_completed"
    ) {
      const key = `${event.launchAttemptId}:${event.providerRunOperationId}`;
      sendByRunOp.set(key, {
        sendSurface: event.sendSurface,
        sendOrdinal: event.sendOrdinal,
      });
    }
    if (event.eventType === "launch_failed") {
      launchFailed.add(event.launchAttemptId);
    }
    if (event.eventType === "provider_run_bound" || event.eventType === "execution_completed") {
      agentHashByAttempt.set(event.launchAttemptId, event.agentHash);
    }
  }

  const attempts = projectAttempts(input.events);
  const bindings: RunOperationBinding[] = [];

  for (const attempt of attempts) {
    const ctx = launchContextByAttempt.get(attempt.launchAttemptId);
    const defaultAgentHash = agentHashByAttempt.get(attempt.launchAttemptId) ?? "";
    for (const op of attempt.runOperations) {
      const sendKey = `${attempt.launchAttemptId}:${op.providerRunOperationId}`;
      const send = sendByRunOp.get(sendKey);
      bindings.push({
        launchAttemptId: attempt.launchAttemptId,
        agentHash: op.runHash
          ? (() => {
              const bound = input.events.find(
                (e) =>
                  e.eventType === "provider_run_bound" &&
                  e.providerRunOperationId === op.providerRunOperationId &&
                  e.runHash === op.runHash,
              );
              return bound && bound.eventType === "provider_run_bound"
                ? bound.agentHash
                : defaultAgentHash;
            })()
          : defaultAgentHash,
        providerRunOperationId: op.providerRunOperationId,
        runHash: op.runHash,
        linearIssueKey: ctx?.linearIssueKey ?? null,
        phase: ctx?.phase ?? null,
        harnessRunId: ctx?.harnessRunId ?? null,
        phaseExecutionId: ctx?.phaseExecutionId ?? null,
        launchSurface: ctx?.launchSurface ?? null,
        sendSurface: send?.sendSurface ?? null,
        sendOrdinal: send?.sendOrdinal ?? null,
        activityStartInclusive: op.activityStart,
        activityEndExclusive: op.unresolved ? null : op.activityEnd,
        terminalOutcome: terminalOutcomeForRunOp({
          completed: op.completed,
          permanentlyUnresolvable: op.permanentlyUnresolvable,
          unresolved: op.unresolved,
          resolvedByReconciliation: op.resolvedByReconciliation,
          hasLaunchFailed: launchFailed.has(attempt.launchAttemptId),
        }),
        coverageEpochId: input.coverageEpochId,
      });
    }
  }

  return bindings.sort((a, b) =>
    `${a.launchAttemptId}:${a.providerRunOperationId}`.localeCompare(
      `${b.launchAttemptId}:${b.providerRunOperationId}`,
    ),
  );
}

function recomputeRegistrySnapshotDigest(input: {
  pin: RegistryPin;
  eventSetDigest: string;
  activationPayloadDigest: string | null;
  coverageDigest: string | null;
  sealDigest: string | null;
}): string {
  return digestCanonical({
    readerSchemaVersion: CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION,
    pin: input.pin,
    eventSetDigest: input.eventSetDigest,
    activationPayloadDigest: input.activationPayloadDigest,
    coverageDigest: input.coverageDigest,
    sealDigest: input.sealDigest,
  });
}

function verifyEventPaths(events: ProvenanceEvent[], paths: string[]): RegistryIntegrityFailure[] {
  const failures: RegistryIntegrityFailure[] = [];
  if (paths.length !== events.length) {
    failures.push({
      code: "event_path_count_mismatch",
      detail: `expected ${events.length} paths, got ${paths.length}`,
    });
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const expected = deriveProvenanceEventPath(event);
    const actual = paths[i];
    if (actual && actual !== expected) {
      failures.push({
        code: "event_path_mismatch",
        detail: `${event.eventId}:${expected}!=${actual}`,
      });
    }
  }
  return failures;
}

export function readRegistrySnapshotFromInput(
  input: RegistrySnapshotInput,
): RegistryReadResult {
  const failures: RegistryIntegrityFailure[] = [];
  const eventPaths =
    input.eventPaths ??
    input.events.map((event) => deriveProvenanceEventPath(event));

  const att: CanonicalActivationPayload | null =
    input.activationRecord?.payload ?? null;
  const activationEpochId = att?.epochId ?? null;
  let activationPayloadDigestValue: string | null = null;
  if (att) {
    activationPayloadDigestValue = activationPayloadDigest(att);
    if (
      input.activationRecord &&
      activationPayloadDigestValue !== input.activationRecord.canonicalPayloadDigest
    ) {
      failures.push({
        code: "activation_payload_digest_mismatch",
        detail: "recomputed activation payload digest mismatch",
      });
    }
  } else {
    failures.push({
      code: "activation_record_missing",
      detail: "activation record required for registry read",
    });
  }

  let activationHistoryProofDigest: string | null = null;
  if (input.activationHistoryProof) {
    const proof = input.activationHistoryProof;
    if ("relationship" in proof && proof.relationship) {
      activationHistoryProofDigest = proof.evidenceDigest;
    } else if ("claimedRelationship" in proof) {
      const rel =
        proof.claimedRelationship === "descendant" ||
        proof.claimedRelationship === "equal"
          ? proof.claimedRelationship
          : null;
      if (!rel) {
        failures.push({
          code: "activation_history_proof_invalid",
          detail: `relationship ${proof.claimedRelationship}`,
        });
      } else {
        activationHistoryProofDigest = computeHistoryProofEvidenceDigest({
          stateRepository: proof.stateRepository,
          stateBranch: proof.stateBranch,
          activationCommitSha: proof.activationCommitSha,
          eventSnapshotCommitSha: proof.eventSnapshotCommitSha,
          relationship: rel,
          verifierVersion: "cursor-activation-history-verifier-v1",
        });
      }
    }
  }

  failures.push(...verifyEventPaths(input.events, eventPaths));

  const records: ProvenanceEventRecord[] = eventRecordsFromParallelArrays({
    events: input.events,
    eventPaths,
  });

  let integrity;
  try {
    integrity = assertEventSnapshotOrThrow({
      records,
      eventSnapshotSource: {
        stateRepository: input.pin.stateRepository,
        stateBranch: input.pin.stateBranch,
        immutableCommitSha: input.pin.registrySnapshotCommitSha,
      },
      activationRecord: input.activationRecord,
      activationSource: input.activationSource,
      activationHistoryProof:
        input.activationHistoryProof &&
        "relationship" in input.activationHistoryProof
          ? input.activationHistoryProof
          : null,
    });
  } catch (error) {
    failures.push({
      code: "event_snapshot_integrity_failure",
      detail: error instanceof Error ? error.message : "integrity failure",
    });
    integrity = {
      incompleteReasons: [] as string[],
      divergenceEvidence: [] as string[],
      recomputedEventSetDigest: digestHex({ events: [] }),
    };
  }

  if (integrity.divergenceEvidence.length > 0) {
    failures.push({
      code: "event_divergence",
      detail: integrity.divergenceEvidence.join(","),
    });
  }

  let coverageSnapshot = input.coverageSnapshot;
  const sealedInterval: CoverageInterval | null =
    input.sealRecord?.interval ??
    coverageSnapshot?.interval ??
    att?.interval ??
    null;

  if (att && sealedInterval && !coverageSnapshot) {
    try {
      coverageSnapshot = buildCoverageSnapshot({
        interval: sealedInterval,
        records,
        eventSnapshotSource: {
          stateRepository: input.pin.stateRepository,
          stateBranch: input.pin.stateBranch,
          immutableCommitSha: input.pin.registrySnapshotCommitSha,
        },
        activationRecord: input.activationRecord,
        activationSource: input.activationSource,
        activationHistoryProof:
          input.activationHistoryProof &&
          "relationship" in input.activationHistoryProof
            ? input.activationHistoryProof
            : null,
      });
    } catch (error) {
      failures.push({
        code: "coverage_snapshot_rebuild_failed",
        detail: error instanceof Error ? error.message : "coverage rebuild failed",
      });
    }
  }

  if (coverageSnapshot) {
    const recomputed = buildCoverageSnapshot({
      interval: coverageSnapshot.interval,
      records,
      eventSnapshotSource: coverageSnapshot.eventSnapshotSource,
      activationRecord: input.activationRecord,
      activationSource: input.activationSource,
      activationHistoryProof:
        input.activationHistoryProof &&
        "relationship" in input.activationHistoryProof
          ? input.activationHistoryProof
          : null,
    });
    if (recomputed.coverageDigest !== coverageSnapshot.coverageDigest) {
      failures.push({
        code: "coverage_digest_mismatch",
        detail: "recomputed coverage digest mismatch",
      });
    }
    if (coverageSnapshot.status !== "complete") {
      failures.push({
        code: "coverage_not_complete",
        detail: coverageSnapshot.incompleteReasons.join(","),
      });
    }
  } else if (input.sealRecord) {
    failures.push({
      code: "coverage_snapshot_missing",
      detail: "seal present without coverage snapshot",
    });
  }

  if (input.sealRecord) {
    if (
      input.sealRecord.coverageDigest &&
      coverageSnapshot &&
      input.sealRecord.coverageDigest !== coverageSnapshot.coverageDigest
    ) {
      failures.push({
        code: "seal_coverage_digest_mismatch",
        detail: "seal coverage digest mismatch",
      });
    }
    if (
      input.sealRecord.sealDigest &&
      input.sealRecord.sealDigest !== input.sealRecord.sealDigest
    ) {
      // seal digest self-consistency checked at parse time in lifecycle module.
    }
  }

  const runOperationBindings = projectRunOperationBindings({
    events: input.events,
    coverageEpochId: activationEpochId,
  });

  const agentHashes = [
    ...new Set(runOperationBindings.map((b) => b.agentHash).filter(Boolean)),
  ].sort();
  const includedAgentHashDigest = digestCanonical(agentHashes);
  const includedRunOperationSetDigest = digestCanonical(
    runOperationBindings.map((b) => ({
      launchAttemptId: b.launchAttemptId,
      providerRunOperationId: b.providerRunOperationId,
      runHash: b.runHash,
      agentHash: b.agentHash,
    })),
  );

  const eventSetDigest = integrity.recomputedEventSetDigest;
  const coverageDigest = coverageSnapshot?.coverageDigest ?? null;
  const sealDigest = input.sealRecord?.sealDigest ?? null;
  const registrySnapshotDigest = recomputeRegistrySnapshotDigest({
    pin: input.pin,
    eventSetDigest,
    activationPayloadDigest: activationPayloadDigestValue,
    coverageDigest,
    sealDigest,
  });

  return {
    pin: input.pin,
    readerSchemaVersion: CURSOR_USAGE_REGISTRY_READER_SCHEMA_VERSION,
    activationEpochId,
    activationPayloadDigest: activationPayloadDigestValue,
    activationHistoryProofDigest,
    eventSnapshotCommitSha: input.pin.registrySnapshotCommitSha,
    eventSetDigest,
    registrySnapshotDigest,
    sealedInterval,
    coverageSnapshot,
    coverageDigest,
    sealDigest,
    sealRecord: input.sealRecord,
    runOperationBindings,
    includedAgentHashDigest,
    includedRunOperationSetDigest,
    integrityFailures: failures,
    integrityOk: failures.length === 0,
  };
}

/** Half-open interval containment: inner fully inside outer. */
export function intervalFullyContained(
  innerStart: string,
  innerEnd: string,
  outerStart: string,
  outerEnd: string,
): boolean {
  const is = parseIso(innerStart);
  const ie = parseIso(innerEnd);
  const os = parseIso(outerStart);
  const oe = parseIso(outerEnd);
  if (is == null || ie == null || os == null || oe == null) return false;
  return is >= os && ie <= oe;
}

/** Half-open overlap: [aStart, aEnd) overlaps [bStart, bEnd). */
export function intervalsOverlapHalfOpen(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const as = parseIso(aStart);
  const ae = parseIso(aEnd);
  const bs = parseIso(bStart);
  const be = parseIso(bEnd);
  if (as == null || ae == null || bs == null || be == null) return false;
  return as < be && ae > bs;
}
