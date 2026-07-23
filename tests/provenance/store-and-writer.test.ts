import { describe, expect, it } from "vitest";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { computeLaunchAttemptId } from "../../src/provenance/launch-attempt-id.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import {
  InMemoryProvenanceEventStore,
} from "../../src/provenance/store.js";
import { ProvenanceWriter } from "../../src/provenance/writer.js";
import { parseProvenanceKey } from "../../src/provenance/encryption.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";
import {
  buildCoverageSnapshot,
  projectAttempts,
} from "../../src/provenance/coverage.js";
import { provenanceEventRemotePath } from "../../src/provenance/paths.js";
import { computeCanonicalSemanticDigest } from "../../src/provenance/events.js";

const KEY = parseProvenanceKey("a".repeat(64));

function sampleContext(overrides: { operationOrdinal?: number } = {}) {
  const providerOperationId = allocateProviderOperationId({
    issueKey: "WES-1",
    phase: "planning",
    harnessRunId: "run-1",
    agentRole: "planner",
    action: "create",
    generation: 1,
    launchSurface: "planning.create",
    operationOrdinal: overrides.operationOrdinal ?? 1,
  });
  return createLinearHarnessLaunchContext({
    operatorWorkspaceId: "ws",
    sourceProjectId: "proj",
    linearIssueId: "issue-1",
    linearIssueKey: "WES-1",
    phase: "planning",
    phaseExecutionId: "run-1",
    harnessRunId: "run-1",
    providerOperationId,
    agentRole: "planner",
    action: "create",
    generation: 1,
    priorAgentHash: null,
    targetRepository: "https://github.com/org/repo",
    startingRef: "main",
    prUrl: null,
    prNumber: null,
    orchestratorMarker: "harness-orchestrator-v1",
    orchestratorMarkerVersion: "harness-orchestrator-v1",
    sourceRepositorySha: "sourcsha".padEnd(40, "0"),
    runnerSnapshotVersion: "runner-1",
    workflowRunId: "123",
    launchSurface: "planning.create",
  });
}

describe("provenance store and writer", () => {
  it("commits intent and call-start before provider mutation path in required mode", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });
    const ctx = sampleContext();
    const intent = await writer.writeLaunchIntent(ctx);
    expect(intent.ok).toBe(true);
    const callStart = await writer.writeProviderCallStarted(ctx);
    expect(callStart.ok).toBe(true);
    expect(store.listEvents().map((e) => e.eventType)).toEqual([
      "launch_intent",
      "provider_call_started",
    ]);
  });

  it("identical intent retry is idempotent and restart-stable", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });
    const ctx = sampleContext();
    const first = await writer.writeLaunchIntent(ctx);
    expect(first.idempotent).toBe(false);
    const writer2 = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-22T01:00:00.000Z"),
    });
    const second = await writer2.writeLaunchIntent(ctx);
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(store.listEvents()).toHaveLength(1);
    expect(store.listEvents()[0]?.recordedAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("divergent event fails closed", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
    });
    const ctx = sampleContext();
    await writer.writeLaunchIntent(ctx);
    const attemptId = computeLaunchAttemptId(ctx);
    const path = provenanceEventRemotePath({
      launchAttemptId: attemptId,
      eventType: "launch_intent",
    });
    const existing = await store.loadEvent(path);
    expect(existing).toBeTruthy();
    await expect(
      store.persistImmutableEvent({
        event: {
          ...existing!,
          canonicalSemanticDigest: "0".repeat(64),
        },
        commitMessage: "test",
      }),
    ).rejects.toBeInstanceOf(CursorProvenanceError);
  });

  it("shadow write failure does not block", async () => {
    const writer = new ProvenanceWriter({
      mode: "shadow",
      store: null,
      encryptionKey: KEY,
    });
    const ctx = sampleContext();
    const outcome = await writer.writeLaunchIntent(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(false);
  });

  it("required missing encryption key blocks before provider mutation", async () => {
    const writer = new ProvenanceWriter({
      mode: "required",
      store: new InMemoryProvenanceEventStore(),
      encryptionKey: null,
    });
    const ctx = sampleContext();
    const outcome = await writer.ensureReadyBeforeProviderMutation(ctx);
    expect(outcome.blocked).toBe(true);
    expect(outcome.error?.code).toBe(
      "cursor_provenance_encryption_unavailable",
    );
  });

  it("disabled writes nothing and needs no credentials", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "disabled",
      store,
      encryptionKey: null,
    });
    const ctx = sampleContext();
    await writer.writeLaunchIntent(ctx);
    await writer.writeAgentAcknowledged(ctx, "bc-agent");
    expect(store.listEvents()).toHaveLength(0);
  });

  it("acks agent and binds run without plaintext ids in event JSON", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
    });
    const ctx = sampleContext();
    await writer.writeLaunchIntent(ctx);
    await writer.writeProviderCallStarted(ctx);
    await writer.writeAgentAcknowledged(ctx, "bc-secret-agent");
    await writer.writeProviderRunIntent(ctx, {
      providerRunOperationId: "d".repeat(64),
      sendPurpose: "default",
      sendOrdinal: 1,
    });
    await writer.writeProviderRunCallStarted(ctx, {
      providerRunOperationId: "d".repeat(64),
      sendPurpose: "default",
      sendOrdinal: 1,
    });
    await writer.writeRunBound(ctx, {
      agentId: "bc-secret-agent",
      runId: "run-secret-1",
      providerRunOperationId: "d".repeat(64),
      runStartIso: "2026-07-22T00:01:00.000Z",
      startEvidenceSource: "local_run_acknowledged_timestamp",
    });
    const raw = JSON.stringify(store.listEvents());
    expect(raw).not.toContain("bc-secret-agent");
    expect(raw).not.toContain("run-secret-1");
    // Provenance event store must not persist plaintext provider IDs.
    expect(raw.includes("bc-secret-agent")).toBe(false);
  });

  it("canonical digest independent of retry timestamp", () => {
    const d1 = computeCanonicalSemanticDigest({
      eventType: "provider_call_started",
      launchAttemptId: "a".repeat(64),
      transitionId: "provider_call_started",
      launchContextDigest: "b".repeat(64),
      semanticPayload: {},
    });
    const d2 = computeCanonicalSemanticDigest({
      eventType: "provider_call_started",
      launchAttemptId: "a".repeat(64),
      transitionId: "provider_call_started",
      launchContextDigest: "b".repeat(64),
      semanticPayload: {},
    });
    expect(d1).toBe(d2);
  });

  it("distinct operation ordinals yield distinct attempt ids", () => {
    const a = sampleContext({ operationOrdinal: 1 });
    const b = sampleContext({ operationOrdinal: 2 });
    expect(computeLaunchAttemptId(a)).not.toBe(computeLaunchAttemptId(b));
  });

  it("coverage marks unresolved intent incomplete and uses closed intervals", async () => {
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
    });
    const ctx = sampleContext();
    await writer.writeLaunchIntent(ctx);
    const events = store.listEvents();
    const attempts = projectAttempts(events);
    expect(attempts[0]?.unresolved).toBe(true);
    const snap = buildCoverageSnapshot({
      interval: {
        coverageStart: "2026-07-01T00:00:00.000Z",
        coverageEnd: "2026-08-01T00:00:00.000Z",
      },
      events,
      eventPaths: ["p"],
      immutableEventSetCommitSha: "c".repeat(40),
    });
    expect(snap.status).toBe("incomplete");
    expect(snap.unresolvedIntentCount).toBeGreaterThan(0);
    expect(snap.interval.coverageEnd).toBeTruthy();
  });

  it("rejects open-ended coverage intervals", () => {
    expect(() =>
      buildCoverageSnapshot({
        interval: {
          coverageStart: "2026-07-01T00:00:00.000Z",
          coverageEnd: "2026-07-01T00:00:00.000Z",
        },
        events: [],
        eventPaths: [],
        immutableEventSetCommitSha: "c".repeat(40),
      }),
    ).toThrow(CursorProvenanceError);
  });
});
