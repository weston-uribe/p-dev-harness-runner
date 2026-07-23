import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ACTIVATION_ATTESTATION_SCHEMA_KIND,
  activationAttestationDigest,
  productionLaunchSurfacesManifestPin,
  productionSendSurfacesManifestPin,
  type CoverageActivationAttestation,
  type SurfaceInstallAttestation,
} from "../../src/provenance/activation-attestation.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { parseProvenanceKey } from "../../src/provenance/encryption.js";
import { validateEventSnapshot } from "../../src/provenance/event-integrity.js";
import type { ProvenanceEventRecord } from "../../src/provenance/event-integrity.js";
import {
  buildReconciliationResolutionEvent,
  computeEventId,
} from "../../src/provenance/events.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { computeLaunchAttemptId } from "../../src/provenance/launch-attempt-id.js";
import {
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
  PROVENANCE_WRITER_VERSION,
} from "../../src/provenance/launch-surfaces.js";
import { deriveProvenanceEventPath } from "../../src/provenance/paths.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import { allocateProviderRunOperationId } from "../../src/provenance/run-operation-id.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";
import { ProvenanceWriter } from "../../src/provenance/writer.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";

const KEY = parseProvenanceKey("a".repeat(64));
const DIGEST = "d".repeat(64);

const INTERVAL = {
  coverageStart: "2026-07-10T00:00:00.000Z",
  coverageEnd: "2026-07-20T00:00:00.000Z",
} as const;

const INSTALLED_FROM = "2026-06-01T00:00:00.000Z";
const SOURCE_SHA = "a".repeat(40);
const RUNNER_VERSION = "runner-snap-1";
const STATE_REPO = "weston-uribe/p-dev-harness-state";
const STATE_BRANCH = "p-dev-runtime-state";
const ACTIVATION_COMMIT = "b".repeat(40);
const EVENT_COMMIT = "c".repeat(40);
const ATTESTATION_DIGEST = "1".repeat(64);

type CoverageInput = Parameters<typeof buildCoverageSnapshot>[0];

export interface CompleteFixture {
  input: CoverageInput;
  launchAttemptId: string;
  runOpId: string;
}

function sampleLaunchContext() {
  const ctx = createLinearHarnessLaunchContext({
    operatorWorkspaceId: "ws",
    sourceProjectId: "proj",
    linearIssueId: "issue-1",
    linearIssueKey: "WES-1",
    phase: "planning",
    phaseExecutionId: "run-1",
    harnessRunId: "run-1",
    providerOperationId: allocateProviderOperationId({
      issueKey: "WES-1",
      phase: "planning",
      harnessRunId: "run-1",
      agentRole: "planner",
      action: "create",
      generation: 1,
      launchSurface: "planning.create",
      operationOrdinal: 1,
    }),
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
    sourceRepositorySha: SOURCE_SHA,
    runnerSnapshotVersion: RUNNER_VERSION,
    workflowRunId: "wf-1",
    launchSurface: "planning.create",
  });
  return ctx;
}

function surfaceInstallAttestations(): SurfaceInstallAttestation[] {
  const launch = PRODUCTION_LAUNCH_SURFACES.map((surface) => ({
    kind: "launch" as const,
    surface,
    installedFrom: INSTALLED_FROM,
    installedUntil: null,
    evidenceDigest: DIGEST,
  }));
  const send = PRODUCTION_SEND_SURFACES.map((surface) => ({
    kind: "send" as const,
    surface,
    installedFrom: INSTALLED_FROM,
    installedUntil: null,
    evidenceDigest: DIGEST,
  }));
  return [...launch, ...send];
}

function buildActivationAttestation(
  overrides: Partial<CoverageActivationAttestation> = {},
): CoverageActivationAttestation {
  const base: CoverageActivationAttestation = {
    kind: ACTIVATION_ATTESTATION_SCHEMA_KIND,
    version: "1",
    epochId: "epoch-1",
    activatedAt: INSTALLED_FROM,
    interval: { ...INTERVAL },
    requiredWriterMode: "required",
    writerVersion: PROVENANCE_WRITER_VERSION,
    contextSchemaVersion: "1",
    eventSchemaVersion: "1",
    coverageSchemaVersion: "1",
    launchSurfacesManifest: productionLaunchSurfacesManifestPin(),
    sendSurfacesManifest: productionSendSurfacesManifestPin(),
    sourceShaAllowlist: [SOURCE_SHA],
    runnerSnapshotVersionAllowlist: [RUNNER_VERSION],
    workflowInstallAttestations: [
      {
        workflowId: "harness-run",
        workflowVersion: "1",
        installedFrom: INSTALLED_FROM,
        installedUntil: null,
        evidenceDigest: DIGEST,
      },
    ],
    surfaceInstallAttestations: surfaceInstallAttestations(),
    runnerVersionInstallAttestations: [
      {
        runnerSnapshotVersion: RUNNER_VERSION,
        installedFrom: INSTALLED_FROM,
        installedUntil: null,
        evidenceDigest: DIGEST,
      },
    ],
    stateRepository: STATE_REPO,
    stateBranch: STATE_BRANCH,
    activationSource: {
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      activationRecordPath: ".p-dev/coverage/activation.json",
      activationCommitSha: ACTIVATION_COMMIT,
      attestationDigest: ATTESTATION_DIGEST,
    },
    deactivationOrInvalidationEvidence: null,
    knownWriterOutagesOrGaps: [],
    ...overrides,
  };
  return base;
}

async function buildCompleteEventRecords(
  ctx = sampleLaunchContext(),
): Promise<{ records: ProvenanceEventRecord[]; launchAttemptId: string; runOpId: string }> {
  const store = new InMemoryProvenanceEventStore();
  const writer = new ProvenanceWriter({
    mode: "required",
    store,
    encryptionKey: KEY,
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
  const launchAttemptId = computeLaunchAttemptId(ctx);
  const runOpId = allocateProviderRunOperationId({
    launchAttemptId,
    sendSurface: "planning.send",
    sendOrdinal: 1,
  });

  await writer.writeLaunchIntent(ctx);
  await writer.writeProviderCallStarted(ctx);
  await writer.writeAgentAcknowledged(ctx, "bc-test-agent");
  await writer.writeProviderRunIntent(ctx, {
    providerRunOperationId: runOpId,
    sendSurface: "planning.send",
    sendOrdinal: 1,
  });
  await writer.writeProviderRunCallStarted(ctx, {
    providerRunOperationId: runOpId,
    sendSurface: "planning.send",
    sendOrdinal: 1,
  });
  await writer.writeRunBound(ctx, {
    agentId: "bc-test-agent",
    runId: "run-test-1",
    providerRunOperationId: runOpId,
    sendSurface: "planning.send",
    sendOrdinal: 1,
    runStartIso: "2026-07-15T12:01:00.000Z",
    startEvidenceSource: "local_run_acknowledged_timestamp",
  });
  await writer.writeExecutionCompleted(ctx, {
    agentId: "bc-test-agent",
    runId: "run-test-1",
    providerRunOperationId: runOpId,
    sendSurface: "planning.send",
    sendOrdinal: 1,
    terminalStatus: "FINISHED",
    windowStartIso: "2026-07-15T12:01:00.000Z",
    windowEndIso: "2026-07-15T13:00:00.000Z",
    startEvidenceSource: "local_run_acknowledged_timestamp",
    endEvidenceSource: "local_terminal_observation_timestamp",
    completionEvidenceSource: "local_terminal_observation_timestamp",
  });

  const records = store.listEvents().map((event) => ({
    event,
    path: deriveProvenanceEventPath(event),
  }));
  return { records, launchAttemptId, runOpId };
}

export async function makeCompleteFixture(): Promise<CompleteFixture> {
  const ctx = sampleLaunchContext();
  const { records, launchAttemptId, runOpId } = await buildCompleteEventRecords(ctx);
  const activationAttestation = buildActivationAttestation();
  const activationSource = { ...activationAttestation.activationSource };

  return {
    launchAttemptId,
    runOpId,
    input: {
      interval: { ...INTERVAL },
      records,
      eventSnapshotSource: {
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        immutableCommitSha: EVENT_COMMIT,
      },
      activationAttestation,
      activationSource,
      eventCommitDescendedFromActivation: true,
    },
  };
}

function cloneInput(input: CoverageInput): CoverageInput {
  return structuredClone(input);
}

function snapshotStatus(input: CoverageInput): "complete" | "incomplete" | "threw" {
  try {
    return buildCoverageSnapshot(input).status;
  } catch {
    return "threw";
  }
}

function expectNotComplete(input: CoverageInput): void {
  expect(snapshotStatus(input)).not.toBe("complete");
}

function expectComplete(input: CoverageInput): void {
  const snap = buildCoverageSnapshot(input);
  expect(snap.status).toBe("complete");
  expect(snap.incompleteReasons).toEqual([]);
}

describe("coverage adversarial completeness", () => {
  it("complete fixture returns status complete", async () => {
    const fixture = await makeCompleteFixture();
    expectComplete(fixture.input);
    expect(activationAttestationDigest(fixture.input.activationAttestation!)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(validateEventSnapshot(fixture.input).ok).toBe(true);
  });

  it("reverse-ordered valid input remains complete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = [...input.records].reverse();
    expectComplete(input);
  });

  it("completion-before-binding input order remains complete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const byType = new Map(input.records.map((r) => [r.event.eventType, r]));
    input.records = [
      byType.get("launch_intent")!,
      byType.get("provider_call_started")!,
      byType.get("provider_agent_acknowledged")!,
      byType.get("provider_run_intent")!,
      byType.get("provider_run_call_started")!,
      byType.get("execution_completed")!,
      byType.get("provider_run_bound")!,
    ];
    expectComplete(input);
  });

  it("empty expected launch surfaces", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.launchSurfacesManifest.surfaces = [];
    expectNotComplete(input);
  });

  it("empty expected send surfaces", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.sendSurfacesManifest.surfaces = [];
    expectNotComplete(input);
  });

  it("one omitted canonical launch surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const manifest = input.activationAttestation!.launchSurfacesManifest;
    manifest.surfaces = manifest.surfaces.filter((s) => s !== "planning.create");
    input.activationAttestation!.surfaceInstallAttestations =
      input.activationAttestation!.surfaceInstallAttestations.filter(
        (row) => !(row.kind === "launch" && row.surface === "planning.create"),
      );
    expectNotComplete(input);
  });

  it("one omitted canonical send surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const manifest = input.activationAttestation!.sendSurfacesManifest;
    manifest.surfaces = manifest.surfaces.filter((s) => s !== "planning.send");
    input.activationAttestation!.surfaceInstallAttestations =
      input.activationAttestation!.surfaceInstallAttestations.filter(
        (row) => !(row.kind === "send" && row.surface === "planning.send"),
      );
    expectNotComplete(input);
  });

  it("unknown extra launch surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.launchSurfacesManifest.surfaces = [
      ...input.activationAttestation!.launchSurfacesManifest.surfaces,
      "planning.extra",
    ];
    expectNotComplete(input);
  });

  it("unknown extra send surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.sendSurfacesManifest.surfaces = [
      ...input.activationAttestation!.sendSurfacesManifest.surfaces,
      "planning.send.extra",
    ];
    expectNotComplete(input);
  });

  it("incorrect launch-manifest kind/version/digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.launchSurfacesManifest = {
      ...input.activationAttestation!.launchSurfacesManifest,
      kind: "wrong.kind",
      version: "1",
      digest: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("incorrect send-manifest kind/version/digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.sendSurfacesManifest = {
      ...input.activationAttestation!.sendSurfacesManifest,
      kind: "wrong.kind",
      version: "1",
      digest: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("empty source allowlist", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.sourceShaAllowlist = [];
    expectNotComplete(input);
  });

  it("empty runner allowlist", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.runnerSnapshotVersionAllowlist = [];
    expectNotComplete(input);
  });

  it("missing workflow install attestations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.workflowInstallAttestations = [];
    expectNotComplete(input);
  });

  it("missing runner install attestations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.runnerVersionInstallAttestations = [];
    expectNotComplete(input);
  });

  it("missing launch-surface installation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.surfaceInstallAttestations =
      input.activationAttestation!.surfaceInstallAttestations.filter(
        (row) => row.kind !== "launch",
      );
    expectNotComplete(input);
  });

  it("missing send-surface installation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.surfaceInstallAttestations =
      input.activationAttestation!.surfaceInstallAttestations.filter(
        (row) => row.kind !== "send",
      );
    expectNotComplete(input);
  });

  it("duplicate installation records", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const dup = input.activationAttestation!.surfaceInstallAttestations.find(
      (row) => row.kind === "launch",
    )!;
    input.activationAttestation!.surfaceInstallAttestations = [
      ...input.activationAttestation!.surfaceInstallAttestations,
      { ...dup },
    ];
    expectNotComplete(input);
  });

  it("conflicting installation records", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.surfaceInstallAttestations.push({
      kind: "launch",
      surface: "planning.unknown",
      installedFrom: INSTALLED_FROM,
      installedUntil: null,
      evidenceDigest: DIGEST,
    });
    expectNotComplete(input);
  });

  it("partial-interval installation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.surfaceInstallAttestations =
      input.activationAttestation!.surfaceInstallAttestations.map((row) => ({
        ...row,
        installedUntil: "2026-07-11T00:00:00.000Z",
      }));
    expectNotComplete(input);
  });

  it("activation source repository mismatch", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationSource!.stateRepository = "other/repo";
    expectNotComplete(input);
  });

  it("activation source branch mismatch", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationSource!.stateBranch = "other-branch";
    expectNotComplete(input);
  });

  it("activation record digest mismatch", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationSource!.attestationDigest = "2".repeat(64);
    expectNotComplete(input);
  });

  it("event snapshot repository mismatch", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.eventSnapshotSource.stateRepository = "other/repo";
    expectNotComplete(input);
  });

  it("event snapshot branch mismatch", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.eventSnapshotSource.stateBranch = "other-branch";
    expectNotComplete(input);
  });

  it("invalid event snapshot commit", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.eventSnapshotSource.immutableCommitSha = "not-a-commit";
    expectNotComplete(input);
  });

  it("invalid activation/event commit relationship", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.eventCommitDescendedFromActivation = false;
    expectNotComplete(input);
  });

  it("writer outage overlap", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.knownWriterOutagesOrGaps = [
      {
        from: "2026-07-12T00:00:00.000Z",
        until: "2026-07-13T00:00:00.000Z",
        reason: "store_unavailable",
      },
    ];
    expectNotComplete(input);
  });

  it("deactivation/invalidation overlap", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationAttestation!.deactivationOrInvalidationEvidence = DIGEST;
    expectNotComplete(input);
  });

  it("tampered event payload with unchanged valid stored digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const intent = input.records.find((r) => r.event.eventType === "launch_intent")!;
    intent.event = {
      ...intent.event,
      sourceRepositorySha: "f".repeat(40),
    };
    expectNotComplete(input);
  });

  it("tampered encrypted envelope metadata", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ack = input.records.find(
      (r) => r.event.eventType === "provider_agent_acknowledged",
    )!;
    if (ack.event.eventType !== "provider_agent_acknowledged") throw new Error("missing ack");
    ack.event = {
      ...ack.event,
      agentIdEnvelope: {
        ...ack.event.agentIdEnvelope,
        aadPurpose: "tampered-purpose",
      },
    };
    expectNotComplete(input);
  });

  it("tampered launch-context digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const call = input.records.find(
      (r) => r.event.eventType === "provider_call_started",
    )!;
    call.event = {
      ...call.event,
      launchContextDigest: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("tampered transition ID", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const call = input.records.find(
      (r) => r.event.eventType === "provider_call_started",
    )!;
    call.event = {
      ...call.event,
      transitionId: "tampered_transition",
    };
    expectNotComplete(input);
  });

  it("tampered event ID", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const call = input.records.find(
      (r) => r.event.eventType === "provider_call_started",
    )!;
    call.event = {
      ...call.event,
      eventId: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("tampered derived path", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records[0]!.path = "tampered/path.json";
    expectNotComplete(input);
  });

  it("omitted predecessor event", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = input.records.filter((r) => r.event.eventType !== "launch_intent");
    expectNotComplete(input);
  });

  it("duplicate transition", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const call = input.records.find(
      (r) => r.event.eventType === "provider_call_started",
    )!;
    input.records.push({
      path: call.path.replace(".json", ".dup.json"),
      event: {
        ...call.event,
        eventId: computeEventId({
          launchAttemptId: call.event.launchAttemptId,
          transitionId: call.event.transitionId,
          eventType: "provider_call_started",
        }),
      },
    });
    expectNotComplete(input);
  });

  it("divergent run operation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const otherCtx = sampleLaunchContext();
    const otherAttempt = computeLaunchAttemptId(otherCtx);
    const runIntent = input.records.find(
      (r) => r.event.eventType === "provider_run_intent",
    )!;
    if (runIntent.event.eventType !== "provider_run_intent") {
      throw new Error("missing run intent");
    }
    const divergentIntent = {
      ...runIntent.event,
      launchAttemptId: otherAttempt,
      eventId: computeEventId({
        launchAttemptId: otherAttempt,
        transitionId: runIntent.event.transitionId,
        eventType: "provider_run_intent",
      }),
    };
    input.records.push({
      event: divergentIntent,
      path: deriveProvenanceEventPath(divergentIntent),
    });
    expectNotComplete(input);
  });

  it("divergent run hash binding", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const bound = input.records.find((r) => r.event.eventType === "provider_run_bound")!;
    const completed = input.records.find(
      (r) => r.event.eventType === "execution_completed",
    )!;
    if (bound.event.eventType !== "provider_run_bound") throw new Error("missing bind");
    if (completed.event.eventType !== "execution_completed") {
      throw new Error("missing completion");
    }
    const otherHash = createHash("sha256").update("other-run").digest("hex");
    completed.event = { ...completed.event, runHash: otherHash };
    expectNotComplete(input);
  });

  it("unresolved launch operation", async () => {
    const ctx = sampleLaunchContext();
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    await writer.writeLaunchIntent(ctx);
    await writer.writeProviderCallStarted(ctx);
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = store.listEvents().map((event) => ({
      event,
      path: deriveProvenanceEventPath(event),
    }));
    expectNotComplete(input);
  });

  it("unresolved run operation", async () => {
    const ctx = sampleLaunchContext();
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const runOpId = allocateProviderRunOperationId({
      launchAttemptId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeLaunchIntent(ctx);
    await writer.writeProviderCallStarted(ctx);
    await writer.writeAgentAcknowledged(ctx, "bc-test-agent");
    await writer.writeProviderRunIntent(ctx, {
      providerRunOperationId: runOpId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeProviderRunCallStarted(ctx, {
      providerRunOperationId: runOpId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = store.listEvents().map((event) => ({
      event,
      path: deriveProvenanceEventPath(event),
    }));
    expectNotComplete(input);
  });

  it("unknown reconciliation kind", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-15T14:00:00.000Z",
      resolutionId: "res-unknown",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
      resolutionKind: "provider_agent_ack_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    recon.resolutionKind = "unknown_kind" as never;
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("disallowed reconciliation evidence source", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-15T14:00:00.000Z",
      resolutionId: "res-bad-source",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
      resolutionKind: "provider_agent_ack_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    recon.evidenceSource = "disallowed_source" as never;
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("reconciliation instant before activity start", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-01T00:00:00.000Z",
      resolutionId: "res-early",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      authoritativeResolutionInstant: "2026-07-01T00:00:00.000Z",
      resolutionKind: "provider_terminal_window_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it('"not started" after provider acknowledgment', async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-15T14:00:00.000Z",
      resolutionId: "res-not-started",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
      resolutionKind: "provider_mutation_proven_not_started",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("agent acknowledgment recovery with unresolved possible run", async () => {
    const ctx = sampleLaunchContext();
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const runOpId = allocateProviderRunOperationId({
      launchAttemptId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeLaunchIntent(ctx);
    await writer.writeProviderCallStarted(ctx);
    await writer.writeProviderRunIntent(ctx, {
      providerRunOperationId: runOpId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeReconciliationResolution(ctx, {
      resolutionId: "res-ack",
      affectedOperationId: launchAttemptId,
      affectedOperationKind: "launch_attempt",
      authoritativeResolutionInstant: "2026-07-15T13:00:00.000Z",
      resolutionKind: "provider_agent_ack_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = store.listEvents().map((event) => ({
      event,
      path: deriveProvenanceEventPath(event),
    }));
    expectNotComplete(input);
  });

  it("run-binding recovery without terminal recovery", async () => {
    const ctx = sampleLaunchContext();
    const store = new InMemoryProvenanceEventStore();
    const writer = new ProvenanceWriter({
      mode: "required",
      store,
      encryptionKey: KEY,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const launchAttemptId = computeLaunchAttemptId(ctx);
    const runOpId = allocateProviderRunOperationId({
      launchAttemptId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeLaunchIntent(ctx);
    await writer.writeProviderCallStarted(ctx);
    await writer.writeAgentAcknowledged(ctx, "bc-test-agent");
    await writer.writeProviderRunIntent(ctx, {
      providerRunOperationId: runOpId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeProviderRunCallStarted(ctx, {
      providerRunOperationId: runOpId,
      sendSurface: "planning.send",
      sendOrdinal: 1,
    });
    await writer.writeReconciliationResolution(ctx, {
      resolutionId: "res-bind",
      affectedOperationId: runOpId,
      affectedOperationKind: "run_operation",
      authoritativeResolutionInstant: "2026-07-15T13:00:00.000Z",
      resolutionKind: "provider_run_binding_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = store.listEvents().map((event) => ({
      event,
      path: deriveProvenanceEventPath(event),
    }));
    expectNotComplete(input);
  });

  it("conflicting reconciliations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-15T14:00:00.000Z",
      resolutionId: "res-conflict",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
      resolutionKind: "provider_agent_ack_recovered",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("permanently unresolvable operation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const ctx = sampleLaunchContext();
    const recon = buildReconciliationResolutionEvent({
      launchAttemptId: fixture.launchAttemptId,
      launchContext: ctx,
      recordedAt: "2026-07-15T14:00:00.000Z",
      resolutionId: "res-perm",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
      resolutionKind: "operation_permanently_unresolvable",
      evidenceSource: "operator_attestation",
      evidenceDigest: DIGEST,
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });
});

describe("coverage adversarial integrity throws", () => {
  it("duplicate event ID fails closed before snapshot", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const dup = input.records[0]!;
    input.records.push({
      path: `${dup.path}.dup`,
      event: { ...dup.event },
    });
    expect(() => buildCoverageSnapshot(input)).toThrow(CursorProvenanceError);
  });
});
