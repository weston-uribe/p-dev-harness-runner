import { describe, expect, it } from "vitest";
import {
  attemptOverlapsInterval,
  buildCoverageSnapshotFromLegacy,
  projectAttempts,
  runOperationOverlapsInterval,
  type AttemptProjection,
} from "../../src/provenance/coverage.js";
import type { ProvenanceEvent } from "../../src/provenance/events.js";
import { PROVENANCE_WRITER_VERSION } from "../../src/provenance/launch-surfaces.js";
import { PROVENANCE_EVENT_SCHEMA_KIND } from "../../src/provenance/events.js";

const INTERVAL = {
  coverageStart: "2026-07-10T00:00:00.000Z",
  coverageEnd: "2026-07-20T00:00:00.000Z",
};

function base(overrides: Partial<ProvenanceEvent> & { eventType: ProvenanceEvent["eventType"]; launchAttemptId: string; transitionId: string }): ProvenanceEvent {
  const common = {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    schemaVersion: "1" as const,
    eventId: "e".repeat(64),
    launchContextDigest: "c".repeat(64),
    recordedAt: "2026-07-01T00:00:00.000Z",
    producerVersion: PROVENANCE_WRITER_VERSION,
    sourceRepositorySha: "s".repeat(40),
    runnerSnapshotVersion: "runner-1",
    workflowRunId: null,
    writerVersion: PROVENANCE_WRITER_VERSION,
    canonicalSemanticDigest: "d".repeat(64),
  };
  return { ...common, ...overrides } as ProvenanceEvent;
}

describe("coverage overlap projection", () => {
  it("1. intent before interval, unresolved during interval", () => {
    const events = [
      base({
        eventType: "launch_intent",
        launchAttemptId: "a".repeat(64),
        transitionId: "launch_intent",
        recordedAt: "2026-07-01T00:00:00.000Z",
        launchContext: {} as never,
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attempts[0]?.unresolved).toBe(true);
    expect(attempts[0]?.activityEnd).toBeNull();
    expect(attemptOverlapsInterval(attempts[0]!, INTERVAL)).toBe(true);
  });

  it("2. call-start before interval without acknowledgment overlaps later", () => {
    const id = "b".repeat(64);
    const events = [
      base({
        eventType: "launch_intent",
        launchAttemptId: id,
        transitionId: "launch_intent",
        recordedAt: "2026-07-01T00:00:00.000Z",
        launchContext: {} as never,
      }),
      base({
        eventType: "provider_call_started",
        launchAttemptId: id,
        transitionId: "provider_call_started",
        recordedAt: "2026-07-01T00:01:00.000Z",
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attemptOverlapsInterval(attempts[0]!, INTERVAL)).toBe(true);
  });

  it("3. acknowledgment before interval without run binding remains open-ended", () => {
    const id = "c".repeat(64);
    const events = [
      base({
        eventType: "launch_intent",
        launchAttemptId: id,
        transitionId: "launch_intent",
        recordedAt: "2026-07-01T00:00:00.000Z",
        launchContext: {} as never,
      }),
      base({
        eventType: "provider_call_started",
        launchAttemptId: id,
        transitionId: "provider_call_started",
        recordedAt: "2026-07-01T00:01:00.000Z",
      }),
      base({
        eventType: "provider_agent_acknowledged",
        launchAttemptId: id,
        transitionId: "provider_agent_acknowledged",
        recordedAt: "2026-07-01T00:02:00.000Z",
        agentHash: "h".repeat(64),
        agentIdEnvelope: {} as never,
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attempts[0]?.activityEnd).toBeNull();
    expect(attemptOverlapsInterval(attempts[0]!, INTERVAL)).toBe(true);
  });

  it("4. run starts before interval and completes inside it", () => {
    const id = "d".repeat(64);
    const runOp = "r".repeat(64);
    const events = [
      base({
        eventType: "provider_run_bound",
        launchAttemptId: id,
        transitionId: `provider_run_bound:${runOp}`,
        providerRunOperationId: runOp,
        agentHash: "h".repeat(64),
        agentIdEnvelope: {} as never,
        runHash: "x".repeat(64),
        runIdEnvelope: {} as never,
        executionBindingDigest: "b".repeat(64),
        executionWindow: {
          startInclusive: "2026-07-09T12:00:00.000Z",
          endExclusive: null,
          startEvidenceSource: "local_run_acknowledged_timestamp",
          endEvidenceSource: null,
        },
        providerSdkApiVersion: null,
        linearIssueKey: "WES-1",
        phase: "planning",
        phaseExecutionId: null,
        harnessRunId: "run",
        action: "create",
        generation: 1,
      }),
      base({
        eventType: "execution_completed",
        launchAttemptId: id,
        transitionId: `execution_completed:${runOp}`,
        providerRunOperationId: runOp,
        agentHash: "h".repeat(64),
        runHash: "x".repeat(64),
        terminalStatus: "FINISHED",
        executionWindow: {
          startInclusive: "2026-07-09T12:00:00.000Z",
          endExclusive: "2026-07-15T00:00:00.000Z",
          startEvidenceSource: "local_run_acknowledged_timestamp",
          endEvidenceSource: "local_terminal_observation_timestamp",
        },
        executionWindowDigest: "w".repeat(64),
        completionEvidenceSource: "local_terminal_observation_timestamp",
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attemptOverlapsInterval(attempts[0]!, INTERVAL)).toBe(true);
  });

  it("5. run starts inside interval and completes after it", () => {
    const id = "e".repeat(64);
    const runOp = "f".repeat(64);
    const events = [
      base({
        eventType: "execution_completed",
        launchAttemptId: id,
        transitionId: `execution_completed:${runOp}`,
        providerRunOperationId: runOp,
        agentHash: "h".repeat(64),
        runHash: "x".repeat(64),
        terminalStatus: "FINISHED",
        executionWindow: {
          startInclusive: "2026-07-15T00:00:00.000Z",
          endExclusive: "2026-07-25T00:00:00.000Z",
          startEvidenceSource: "local_run_acknowledged_timestamp",
          endEvidenceSource: "local_terminal_observation_timestamp",
        },
        executionWindowDigest: "w".repeat(64),
        completionEvidenceSource: "local_terminal_observation_timestamp",
      }),
    ];
    expect(attemptOverlapsInterval(projectAttempts(events)[0]!, INTERVAL)).toBe(
      true,
    );
  });

  it("6. run spans the whole interval", () => {
    const id = "g".repeat(64);
    const runOp = "h".repeat(64);
    const events = [
      base({
        eventType: "execution_completed",
        launchAttemptId: id,
        transitionId: `execution_completed:${runOp}`,
        providerRunOperationId: runOp,
        agentHash: "h".repeat(64),
        runHash: "x".repeat(64),
        terminalStatus: "FINISHED",
        executionWindow: {
          startInclusive: "2026-07-01T00:00:00.000Z",
          endExclusive: "2026-07-30T00:00:00.000Z",
          startEvidenceSource: "local_run_acknowledged_timestamp",
          endEvidenceSource: "local_terminal_observation_timestamp",
        },
        executionWindowDigest: "w".repeat(64),
        completionEvidenceSource: "local_terminal_observation_timestamp",
      }),
    ];
    expect(attemptOverlapsInterval(projectAttempts(events)[0]!, INTERVAL)).toBe(
      true,
    );
  });

  it("7. reconciliation after interval can close overlapping attempt", () => {
    const id = "i".repeat(64);
    const events = [
      base({
        eventType: "launch_intent",
        launchAttemptId: id,
        transitionId: "launch_intent",
        recordedAt: "2026-07-01T00:00:00.000Z",
        launchContext: {} as never,
      }),
      base({
        eventType: "provider_call_started",
        launchAttemptId: id,
        transitionId: "provider_call_started",
        recordedAt: "2026-07-01T00:01:00.000Z",
      }),
      base({
        eventType: "reconciliation_resolution",
        launchAttemptId: id,
        transitionId: "reconciliation_resolution:res1",
        resolutionId: "res1",
        affectedOperationId: id,
        affectedOperationKind: "launch_attempt",
        authoritativeResolutionInstant: "2026-07-12T00:00:00.000Z",
        resolutionKind: "provider_agent_ack_recovered",
        evidenceSource: "operator_attestation",
        evidenceDigest: "e".repeat(64),
        producerSchemaVersion: "1",
        recordedAt: "2026-07-25T00:00:00.000Z",
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attempts[0]?.resolvedByReconciliation).toBe(true);
    expect(attempts[0]?.unresolved).toBe(false);
    expect(attemptOverlapsInterval(attempts[0]!, INTERVAL)).toBe(true);
  });

  it("8. completed attempt ending at coverageStart does not overlap", () => {
    const attempt: AttemptProjection = {
      launchAttemptId: "j".repeat(64),
      hasIntent: true,
      hasCallStarted: true,
      hasAgentAck: true,
      runBindings: [
        {
          runHash: "x".repeat(64),
          providerRunOperationId: "r".repeat(64),
          startInclusive: "2026-07-01T00:00:00.000Z",
          endExclusive: INTERVAL.coverageStart,
          completed: true,
        },
      ],
      runOperations: [],
      launchFailedStages: [],
      sourceRepositorySha: "s".repeat(40),
      runnerSnapshotVersion: "r1",
      activityStart: "2026-07-01T00:00:00.000Z",
      activityEnd: INTERVAL.coverageStart,
      unresolved: false,
      resolvedByReconciliation: false,
    };
    expect(attemptOverlapsInterval(attempt, INTERVAL)).toBe(false);
  });

  it("9. run beginning exactly at coverageEnd does not overlap", () => {
    const attempt: AttemptProjection = {
      launchAttemptId: "k".repeat(64),
      hasIntent: true,
      hasCallStarted: true,
      hasAgentAck: true,
      runBindings: [
        {
          runHash: "x".repeat(64),
          providerRunOperationId: "r".repeat(64),
          startInclusive: INTERVAL.coverageEnd,
          endExclusive: "2026-07-30T00:00:00.000Z",
          completed: true,
        },
      ],
      runOperations: [],
      launchFailedStages: [],
      sourceRepositorySha: "s".repeat(40),
      runnerSnapshotVersion: "r1",
      activityStart: INTERVAL.coverageEnd,
      activityEnd: "2026-07-30T00:00:00.000Z",
      unresolved: false,
      resolvedByReconciliation: false,
    };
    expect(attemptOverlapsInterval(attempt, INTERVAL)).toBe(false);
  });

  it("empty interval without activation is incomplete", () => {
    const snap = buildCoverageSnapshotFromLegacy({
      interval: INTERVAL,
      events: [],
      eventPaths: [],
      immutableEventSetCommitSha: "c".repeat(40),
    });
    expect(snap.status).toBe("incomplete");
    expect(snap.incompleteReasons).toContain(
      "coverage_activation_attestation_missing",
    );
  });

  it("completed run does not hide later unresolved run operation", () => {
    const id = "m".repeat(64);
    const op1 = "1".repeat(64);
    const op2 = "2".repeat(64);
    const events: ProvenanceEvent[] = [
      base({
        eventType: "provider_run_intent",
        launchAttemptId: id,
        transitionId: `provider_run_intent:${op1}`,
        providerRunOperationId: op1,
        sendSurface: "initial",
        sendOrdinal: 1,
        recordedAt: "2026-07-11T00:00:00.000Z",
      }),
      base({
        eventType: "provider_run_call_started",
        launchAttemptId: id,
        transitionId: `provider_run_call_started:${op1}`,
        providerRunOperationId: op1,
        sendSurface: "initial",
        sendOrdinal: 1,
        recordedAt: "2026-07-11T00:00:01.000Z",
      }),
      base({
        eventType: "execution_completed",
        launchAttemptId: id,
        transitionId: `execution_completed:${op1}`,
        providerRunOperationId: op1,
        agentHash: "h".repeat(64),
        runHash: "x".repeat(64),
        terminalStatus: "FINISHED",
        executionWindow: {
          startInclusive: "2026-07-11T00:00:02.000Z",
          endExclusive: "2026-07-11T01:00:00.000Z",
          startEvidenceSource: "local_run_acknowledged_timestamp",
          endEvidenceSource: "local_terminal_observation_timestamp",
        },
        executionWindowDigest: "w".repeat(64),
        completionEvidenceSource: "local_terminal_observation_timestamp",
      }),
      base({
        eventType: "provider_run_intent",
        launchAttemptId: id,
        transitionId: `provider_run_intent:${op2}`,
        providerRunOperationId: op2,
        sendSurface: "repair",
        sendOrdinal: 2,
        recordedAt: "2026-07-12T00:00:00.000Z",
      }),
      base({
        eventType: "provider_run_call_started",
        launchAttemptId: id,
        transitionId: `provider_run_call_started:${op2}`,
        providerRunOperationId: op2,
        sendSurface: "repair",
        sendOrdinal: 2,
        recordedAt: "2026-07-12T00:00:01.000Z",
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attempts[0]?.runOperations).toHaveLength(2);
    expect(attempts[0]?.runOperations.some((r) => r.unresolved)).toBe(true);
    expect(attempts[0]?.unresolved).toBe(true);
    const unresolved = attempts[0]!.runOperations.find(
      (r) => r.providerRunOperationId === op2,
    )!;
    expect(runOperationOverlapsInterval(unresolved, INTERVAL)).toBe(true);
  });

  it("reconciliation timestamp alone does not close unresolved activity", () => {
    const id = "n".repeat(64);
    const events = [
      base({
        eventType: "launch_intent",
        launchAttemptId: id,
        transitionId: "launch_intent",
        recordedAt: "2026-07-01T00:00:00.000Z",
        launchContext: {} as never,
      }),
      base({
        eventType: "reconciliation_resolution",
        launchAttemptId: id,
        transitionId: "reconciliation_resolution:bad",
        resolutionId: "bad",
        affectedOperationId: id,
        affectedOperationKind: "launch_attempt",
        authoritativeResolutionInstant: "",
        resolutionKind: "guess",
        evidenceSource: "",
        evidenceDigest: "",
        producerSchemaVersion: "1",
        recordedAt: "2026-07-25T00:00:00.000Z",
      }),
    ];
    const attempts = projectAttempts(events);
    expect(attempts[0]?.resolvedByReconciliation).toBe(false);
    expect(attempts[0]?.unresolved).toBe(true);
  });
});
