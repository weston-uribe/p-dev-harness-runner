import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ACTIVATION_ATTESTATION_SCHEMA_KIND,
  activationPayloadDigest,
  buildPersistedActivationRecord,
  productionLaunchSurfacesManifestPin,
  productionSendSurfacesManifestPin,
  type CanonicalActivationPayload,
  type PersistedActivationRecord,
  type RetrievedActivationSource,
  type SurfaceInstallAttestation,
} from "../../src/provenance/activation-attestation.js";
import {
  createLoopbackCommitGraph,
  verifyActivationHistoryProof,
  type VerifiedActivationHistoryProof,
  ACTIVATION_HISTORY_PROOF_KIND,
} from "../../src/provenance/activation-history-proof.js";
import {
  productionWorkflowInstallManifestPin,
  productionRunnerInstallManifestPin,
  getExpectedRunnerDeploymentSlots,
  runnerInstallationId,
  getProductionWorkflowInstallManifest,
  workflowEntrypointKey,
} from "../../src/provenance/production-install-manifests.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { parseProvenanceKey } from "../../src/provenance/encryption.js";
import { validateEventSnapshot } from "../../src/provenance/event-integrity.js";
import type { ProvenanceEventRecord } from "../../src/provenance/event-integrity.js";
import {
  buildReconciliationResolutionEvent,
  computeEventId,
  deriveProvenanceTransitionId,
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
import type { ReconciliationPayload } from "../../src/provenance/reconciliation.js";
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

type CoverageInput = Parameters<typeof buildCoverageSnapshot>[0];

export interface CompleteFixture {
  input: CoverageInput;
  launchAttemptId: string;
  runOpId: string;
  activationRecord: PersistedActivationRecord;
}

function reconciliationSharedFields(
  overrides: Partial<ReconciliationPayload> = {},
): ReconciliationPayload {
  return {
    resolutionKind: "provider_agent_ack_recovered",
    agentHash: "a".repeat(64),
    acknowledgmentTimestamp: "2026-07-15T13:00:00.000Z",
    evidenceSource: "operator_attestation",
    evidenceDigest: DIGEST,
    authoritativeResolutionInstant: "2026-07-15T13:00:00.000Z",
    producerSchemaVersion: "1",
    sourceRepositorySha: SOURCE_SHA,
    runnerSnapshotVersion: RUNNER_VERSION,
    ...overrides,
  } as ReconciliationPayload;
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

function buildActivationPayload(
  overrides: Partial<CanonicalActivationPayload> = {},
): CanonicalActivationPayload {
  const workflowPin = productionWorkflowInstallManifestPin();
  const runnerPin = productionRunnerInstallManifestPin();
  const slots = getExpectedRunnerDeploymentSlots();
  const workflowManifest = getProductionWorkflowInstallManifest();

  return {
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
    workflowInstallManifest: workflowPin,
    runnerInstallManifest: runnerPin,
    sourceShaAllowlist: [SOURCE_SHA],
    runnerSnapshotVersionAllowlist: [RUNNER_VERSION],
    workflowInstallAttestations: workflowManifest.entrypoints.map((ep) => ({
      entrypointKey: workflowEntrypointKey(ep),
      workflowId: ep.workflowId,
      workflowVersion: "1",
      installedFrom: INSTALLED_FROM,
      installedUntil: null,
      evidenceDigest: DIGEST,
    })),
    surfaceInstallAttestations: surfaceInstallAttestations(),
    runnerVersionInstallAttestations: slots.map((slot) => ({
      installationId: runnerInstallationId(slot),
      runnerSnapshotVersion: RUNNER_VERSION,
      installedFrom: INSTALLED_FROM,
      installedUntil: null,
      evidenceDigest: DIGEST,
    })),
    stateRepository: STATE_REPO,
    stateBranch: STATE_BRANCH,
    lifecycleRecords: [
      {
        lifecycleKind: "activation",
        epochId: "epoch-1",
        effectiveAt: INSTALLED_FROM,
        reasonCode: "activated",
        producerSchemaVersion: "1",
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
      },
    ],
    knownWriterOutagesOrGaps: [],
    ...overrides,
  };
}

function buildVerifiedHistoryProof(input: {
  activationCommitSha?: string;
  eventSnapshotCommitSha?: string;
  claimedRelationship?: "descendant" | "equal";
  edges?: Array<{ sha: string; parents: string[] }>;
}): VerifiedActivationHistoryProof {
  const activationCommitSha = input.activationCommitSha ?? ACTIVATION_COMMIT;
  const eventSnapshotCommitSha = input.eventSnapshotCommitSha ?? EVENT_COMMIT;
  const graph = createLoopbackCommitGraph({
    repository: STATE_REPO,
    branch: STATE_BRANCH,
    edges:
      input.edges ??
      (activationCommitSha === eventSnapshotCommitSha
        ? [{ sha: activationCommitSha, parents: [] }]
        : [
            { sha: activationCommitSha, parents: [] },
            { sha: eventSnapshotCommitSha, parents: [activationCommitSha] },
          ]),
  });
  const verified = verifyActivationHistoryProof({
    record: {
      kind: ACTIVATION_HISTORY_PROOF_KIND,
      version: "1",
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      activationCommitSha,
      eventSnapshotCommitSha,
      claimedRelationship:
        input.claimedRelationship ??
        (activationCommitSha === eventSnapshotCommitSha ? "equal" : "descendant"),
    },
    commitGraph: graph,
    expectedStateRepository: STATE_REPO,
    expectedStateBranch: STATE_BRANCH,
  });
  if (!("relationship" in verified)) {
    throw new Error(verified.reason);
  }
  return verified;
}

function buildActivationFixture(input: {
  payloadOverrides?: Partial<CanonicalActivationPayload>;
  activationCommitSha?: string;
  eventSnapshotCommitSha?: string;
  historyProof?: VerifiedActivationHistoryProof | null;
}): {
  activationRecord: PersistedActivationRecord;
  activationSource: RetrievedActivationSource;
  activationHistoryProof: VerifiedActivationHistoryProof | null;
  eventSnapshotCommitSha: string;
} {
  const payload = buildActivationPayload(input.payloadOverrides);
  const activationRecord = buildPersistedActivationRecord(payload);
  const activationCommitSha = input.activationCommitSha ?? ACTIVATION_COMMIT;
  const eventSnapshotCommitSha = input.eventSnapshotCommitSha ?? EVENT_COMMIT;
  const activationSource: RetrievedActivationSource = {
    stateRepository: STATE_REPO,
    stateBranch: STATE_BRANCH,
    activationRecordPath: ".p-dev/coverage/activation.json",
    immutableCommitSha: activationCommitSha,
    recordContentDigest: activationRecord.canonicalPayloadDigest,
  };
  const activationHistoryProof =
    input.historyProof === undefined
      ? buildVerifiedHistoryProof({
          activationCommitSha,
          eventSnapshotCommitSha,
        })
      : input.historyProof;

  return {
    activationRecord,
    activationSource,
    activationHistoryProof,
    eventSnapshotCommitSha,
  };
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

export async function makeCompleteFixture(
  activationOptions: Parameters<typeof buildActivationFixture>[0] = {},
): Promise<CompleteFixture> {
  const ctx = sampleLaunchContext();
  const { records, launchAttemptId, runOpId } = await buildCompleteEventRecords(ctx);
  const activation = buildActivationFixture(activationOptions);

  return {
    launchAttemptId,
    runOpId,
    activationRecord: activation.activationRecord,
    input: {
      interval: { ...INTERVAL },
      records,
      eventSnapshotSource: {
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        immutableCommitSha: activation.eventSnapshotCommitSha,
      },
      activationRecord: activation.activationRecord,
      activationSource: activation.activationSource,
      activationHistoryProof: activation.activationHistoryProof,
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

function buildReconEvent(
  fixture: CompleteFixture,
  input: {
    resolutionId: string;
    affectedOperationId: string;
    affectedOperationKind: "launch_attempt" | "run_operation";
    payload: ReconciliationPayload;
    recordedAt?: string;
  },
) {
  return buildReconciliationResolutionEvent({
    launchAttemptId: fixture.launchAttemptId,
    launchContext: sampleLaunchContext(),
    recordedAt: input.recordedAt ?? "2026-07-15T14:00:00.000Z",
    resolutionId: input.resolutionId,
    affectedOperationId: input.affectedOperationId,
    affectedOperationKind: input.affectedOperationKind,
    payload: input.payload,
  });
}

describe("coverage adversarial completeness", () => {
  it("complete fixture returns status complete", async () => {
    const fixture = await makeCompleteFixture();
    expectComplete(fixture.input);
    expect(activationPayloadDigest(fixture.activationRecord.payload)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(validateEventSnapshot(fixture.input).ok).toBe(true);
  });

  it("activation record metadata without fetched record bytes", async () => {
    const fixture = await makeCompleteFixture();
    expect(fixture.input.activationRecord).toBeTruthy();
    expect(fixture.input.activationSource).toBeTruthy();
    expect(fixture.input.activationSource?.recordContentDigest).toBe(
      fixture.activationRecord.canonicalPayloadDigest,
    );
    expectComplete(fixture.input);
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

  it("valid descendant history proof from loopback graph", async () => {
    const fixture = await makeCompleteFixture();
    expect(fixture.input.activationHistoryProof?.relationship).toBe("descendant");
    expectComplete(fixture.input);
  });

  it("valid equal-commit history proof", async () => {
    const equalCommit = "e".repeat(40);
    const fixture = await makeCompleteFixture({
      activationCommitSha: equalCommit,
      eventSnapshotCommitSha: equalCommit,
    });
    expect(fixture.input.activationHistoryProof?.relationship).toBe("equal");
    expectComplete(fixture.input);
  });

  it("caller-created descendant relationship without verifier is incomplete", async () => {
    const fixture = await makeCompleteFixture({ historyProof: null });
    expectNotComplete(fixture.input);
    const snap = buildCoverageSnapshot(fixture.input);
    expect(snap.incompleteReasons).toContain(
      "coverage_activation_event_history_proof_missing",
    );
  });

  it("invalid unrelated histories fail verification", () => {
    const unrelatedEventCommit = "f".repeat(40);
    const graph = createLoopbackCommitGraph({
      repository: STATE_REPO,
      branch: STATE_BRANCH,
      edges: [
        { sha: ACTIVATION_COMMIT, parents: [] },
        { sha: unrelatedEventCommit, parents: [] },
      ],
    });
    const verified = verifyActivationHistoryProof({
      record: {
        kind: ACTIVATION_HISTORY_PROOF_KIND,
        version: "1",
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        activationCommitSha: ACTIVATION_COMMIT,
        eventSnapshotCommitSha: unrelatedEventCommit,
        claimedRelationship: "descendant",
      },
      commitGraph: graph,
      expectedStateRepository: STATE_REPO,
      expectedStateBranch: STATE_BRANCH,
    });
    expect("ok" in verified && verified.ok === false).toBe(true);
  });

  it("forged history proof with mismatched event snapshot commit is incomplete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationHistoryProof = buildVerifiedHistoryProof({
      eventSnapshotCommitSha: "0".repeat(40),
    });
    expectNotComplete(input);
    const snap = buildCoverageSnapshot(input);
    expect(snap.incompleteReasons).toContain(
      "coverage_activation_event_history_invalid",
    );
  });

  it("wrong activation source commit pin fails history verification", () => {
    const wrongPin = "f".repeat(40);
    const graph = createLoopbackCommitGraph({
      repository: STATE_REPO,
      branch: STATE_BRANCH,
      edges: [
        { sha: ACTIVATION_COMMIT, parents: [] },
        { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT] },
      ],
    });
    const verified = verifyActivationHistoryProof({
      record: {
        kind: ACTIVATION_HISTORY_PROOF_KIND,
        version: "1",
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        activationCommitSha: wrongPin,
        eventSnapshotCommitSha: EVENT_COMMIT,
        claimedRelationship: "descendant",
      },
      commitGraph: graph,
      expectedStateRepository: STATE_REPO,
      expectedStateBranch: STATE_BRANCH,
    });
    expect("ok" in verified && verified.ok === false).toBe(true);
  });

  it("correct source pin with tampered fetched record bytes is incomplete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord = {
      ...fixture.activationRecord,
      payload: {
        ...fixture.activationRecord.payload,
        epochId: "tampered-epoch",
      },
    };
    expectNotComplete(input);
    const snap = buildCoverageSnapshot(input);
    expect(snap.incompleteReasons).toContain(
      "coverage_attestation_conflicting_install",
    );
  });

  it("activation record with mismatched stored digest is not complete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord = {
      ...fixture.activationRecord,
      canonicalPayloadDigest: "0".repeat(64),
    };
    expectNotComplete(input);
    const snap = buildCoverageSnapshot(input);
    expect(snap.incompleteReasons).toContain(
      "coverage_attestation_conflicting_install",
    );
  });

  it("lifecycle invalidation before coverageEnd is incomplete", async () => {
    const fixture = await makeCompleteFixture({
      payloadOverrides: {
        lifecycleRecords: [
          {
            lifecycleKind: "activation",
            epochId: "epoch-1",
            effectiveAt: INSTALLED_FROM,
            reasonCode: "activated",
            producerSchemaVersion: "1",
            evidenceSource: "operator_attestation",
            evidenceDigest: DIGEST,
          },
          {
            lifecycleKind: "invalidation",
            epochId: "epoch-1",
            effectiveAt: "2026-07-15T00:00:00.000Z",
            reasonCode: "invalidated",
            producerSchemaVersion: "1",
            evidenceSource: "operator_attestation",
            evidenceDigest: DIGEST,
          },
        ],
      },
    });
    expectNotComplete(fixture.input);
    const snap = buildCoverageSnapshot(fixture.input);
    expect(snap.incompleteReasons).toContain("coverage_activation_lifecycle_invalid");
  });

  it("lifecycle invalidation exactly at coverageEnd may remain complete", async () => {
    const fixture = await makeCompleteFixture({
      payloadOverrides: {
        lifecycleRecords: [
          {
            lifecycleKind: "activation",
            epochId: "epoch-1",
            effectiveAt: INSTALLED_FROM,
            reasonCode: "activated",
            producerSchemaVersion: "1",
            evidenceSource: "operator_attestation",
            evidenceDigest: DIGEST,
          },
          {
            lifecycleKind: "invalidation",
            epochId: "epoch-1",
            effectiveAt: INTERVAL.coverageEnd,
            reasonCode: "invalidated",
            producerSchemaVersion: "1",
            evidenceSource: "operator_attestation",
            evidenceDigest: DIGEST,
          },
        ],
      },
    });
    expectComplete(fixture.input);
  });

  it("production workflow discovery includes reconcile-revisions", () => {
    const manifest = getProductionWorkflowInstallManifest();
    expect(
      manifest.entrypoints.some((entry) =>
        entry.workflowPath.includes("harness-reconcile-revisions"),
      ),
    ).toBe(true);
  });

  it("missing canonical runner deployment slot", async () => {
    const slots = getExpectedRunnerDeploymentSlots();
    const fixture = await makeCompleteFixture({
      payloadOverrides: {
        runnerVersionInstallAttestations: slots.slice(1).map((slot) => ({
          installationId: runnerInstallationId(slot),
          runnerSnapshotVersion: RUNNER_VERSION,
          installedFrom: INSTALLED_FROM,
          installedUntil: null,
          evidenceDigest: DIGEST,
        })),
      },
    });
    expectNotComplete(fixture.input);
    const snap = buildCoverageSnapshot(fixture.input);
    expect(snap.incompleteReasons).toContain("coverage_runner_slot_missing");
  });

  it("empty expected launch surfaces", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.launchSurfacesManifest.surfaces = [];
    expectNotComplete(input);
  });

  it("empty expected send surfaces", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.sendSurfacesManifest.surfaces = [];
    expectNotComplete(input);
  });

  it("one omitted canonical launch surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const manifest = input.activationRecord!.payload.launchSurfacesManifest;
    manifest.surfaces = manifest.surfaces.filter((s) => s !== "planning.create");
    input.activationRecord!.payload.surfaceInstallAttestations =
      input.activationRecord!.payload.surfaceInstallAttestations.filter(
        (row) => !(row.kind === "launch" && row.surface === "planning.create"),
      );
    expectNotComplete(input);
  });

  it("one omitted canonical send surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const manifest = input.activationRecord!.payload.sendSurfacesManifest;
    manifest.surfaces = manifest.surfaces.filter((s) => s !== "planning.send");
    input.activationRecord!.payload.surfaceInstallAttestations =
      input.activationRecord!.payload.surfaceInstallAttestations.filter(
        (row) => !(row.kind === "send" && row.surface === "planning.send"),
      );
    expectNotComplete(input);
  });

  it("unknown extra launch surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.launchSurfacesManifest.surfaces = [
      ...input.activationRecord!.payload.launchSurfacesManifest.surfaces,
      "planning.extra",
    ];
    expectNotComplete(input);
  });

  it("unknown extra send surface", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.sendSurfacesManifest.surfaces = [
      ...input.activationRecord!.payload.sendSurfacesManifest.surfaces,
      "planning.send.extra",
    ];
    expectNotComplete(input);
  });

  it("incorrect launch-manifest kind/version/digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.launchSurfacesManifest = {
      ...input.activationRecord!.payload.launchSurfacesManifest,
      kind: "wrong.kind",
      version: "1",
      digest: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("incorrect send-manifest kind/version/digest", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.sendSurfacesManifest = {
      ...input.activationRecord!.payload.sendSurfacesManifest,
      kind: "wrong.kind",
      version: "1",
      digest: "0".repeat(64),
    };
    expectNotComplete(input);
  });

  it("empty source allowlist", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.sourceShaAllowlist = [];
    expectNotComplete(input);
  });

  it("empty runner allowlist", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.runnerSnapshotVersionAllowlist = [];
    expectNotComplete(input);
  });

  it("missing workflow install attestations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.workflowInstallAttestations = [];
    expectNotComplete(input);
  });

  it("missing runner install attestations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.runnerVersionInstallAttestations = [];
    expectNotComplete(input);
  });

  it("missing launch-surface installation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.surfaceInstallAttestations =
      input.activationRecord!.payload.surfaceInstallAttestations.filter(
        (row) => row.kind !== "launch",
      );
    expectNotComplete(input);
  });

  it("missing send-surface installation", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.surfaceInstallAttestations =
      input.activationRecord!.payload.surfaceInstallAttestations.filter(
        (row) => row.kind !== "send",
      );
    expectNotComplete(input);
  });

  it("duplicate installation records", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const dup = input.activationRecord!.payload.surfaceInstallAttestations.find(
      (row) => row.kind === "launch",
    )!;
    input.activationRecord!.payload.surfaceInstallAttestations = [
      ...input.activationRecord!.payload.surfaceInstallAttestations,
      { ...dup },
    ];
    expectNotComplete(input);
  });

  it("conflicting installation records", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.surfaceInstallAttestations.push({
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
    input.activationRecord!.payload.surfaceInstallAttestations =
      input.activationRecord!.payload.surfaceInstallAttestations.map((row) => ({
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

  it("activation record digest mismatch on source pin is incomplete", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord = {
      ...fixture.activationRecord,
      canonicalPayloadDigest: "2".repeat(64),
    };
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

  it("writer outage overlap", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.activationRecord!.payload.knownWriterOutagesOrGaps = [
      {
        from: "2026-07-12T00:00:00.000Z",
        until: "2026-07-13T00:00:00.000Z",
        reason: "store_unavailable",
      },
    ];
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

  it("coordinated transition eventId and digest tamper", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const call = input.records.find(
      (r) => r.event.eventType === "provider_call_started",
    )!;
    const derivedTransitionId = deriveProvenanceTransitionId({
      eventType: "provider_call_started",
    });
    call.event = {
      ...call.event,
      transitionId: `${derivedTransitionId}:tampered`,
      eventId: computeEventId({
        launchAttemptId: call.event.launchAttemptId,
        transitionId: derivedTransitionId,
        eventType: "provider_call_started",
      }),
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
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-unknown",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      payload: reconciliationSharedFields({
        resolutionKind: "provider_agent_ack_recovered",
      }),
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
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-bad-source",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      payload: reconciliationSharedFields({
        evidenceSource: "operator_attestation",
      }),
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
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-early",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      recordedAt: "2026-07-01T00:00:00.000Z",
      payload: {
        resolutionKind: "provider_terminal_window_recovered",
        providerRunOperationId: fixture.runOpId,
        launchAttemptId: fixture.launchAttemptId,
        agentHash: "a".repeat(64),
        runHash: "b".repeat(64),
        sendSurface: "planning.send",
        sendOrdinal: 1,
        terminalStatus: "FINISHED",
        startInclusive: "2026-07-15T12:01:00.000Z",
        endExclusive: "2026-07-15T13:00:00.000Z",
        startEvidenceSource: "local_run_acknowledged_timestamp",
        endEvidenceSource: "local_terminal_observation_timestamp",
        executionWindowDigest: DIGEST,
        executionBindingDigest: DIGEST,
        recoveryEvidenceDigest: DIGEST,
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-01T00:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
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
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-not-started",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      payload: {
        resolutionKind: "provider_mutation_proven_not_started",
        affectedOperationKind: "launch_attempt",
        affectedOperationId: fixture.launchAttemptId,
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
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
      payload: {
        resolutionKind: "provider_agent_ack_recovered",
        agentHash: "a".repeat(64),
        acknowledgmentTimestamp: "2026-07-15T13:00:00.000Z",
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T13:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
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
      payload: {
        resolutionKind: "provider_run_binding_recovered",
        providerRunOperationId: runOpId,
        agentHash: "a".repeat(64),
        runHash: "b".repeat(64),
        sendSurface: "planning.send",
        sendOrdinal: 1,
        executionStartTimestamp: "2026-07-15T12:01:00.000Z",
        startEvidenceSource: "local_run_acknowledged_timestamp",
        recoveredBindingDigest: DIGEST,
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T13:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
    });
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    input.records = store.listEvents().map((event) => ({
      event,
      path: deriveProvenanceEventPath(event),
    }));
    expectNotComplete(input);
  });

  it("terminal recovery with only timestamp is rejected", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-terminal-only",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      payload: {
        resolutionKind: "provider_terminal_window_recovered",
        providerRunOperationId: fixture.runOpId,
        launchAttemptId: fixture.launchAttemptId,
        agentHash: "",
        runHash: "",
        sendSurface: "",
        sendOrdinal: 0,
        terminalStatus: "",
        startInclusive: "",
        endExclusive: "",
        startEvidenceSource: "local_run_acknowledged_timestamp",
        endEvidenceSource: "local_terminal_observation_timestamp",
        executionWindowDigest: "",
        executionBindingDigest: "",
        recoveryEvidenceDigest: "",
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("terminal recovery with mismatched binding digest is rejected", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-terminal-bind",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      payload: {
        resolutionKind: "provider_terminal_window_recovered",
        providerRunOperationId: fixture.runOpId,
        launchAttemptId: fixture.launchAttemptId,
        agentHash: "a".repeat(64),
        runHash: "b".repeat(64),
        sendSurface: "planning.send",
        sendOrdinal: 1,
        terminalStatus: "FINISHED",
        startInclusive: "2026-07-15T12:01:00.000Z",
        endExclusive: "2026-07-15T13:00:00.000Z",
        startEvidenceSource: "local_run_acknowledged_timestamp",
        endEvidenceSource: "local_terminal_observation_timestamp",
        executionWindowDigest: DIGEST,
        executionBindingDigest: "0".repeat(64),
        recoveryEvidenceDigest: DIGEST,
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
    });
    input.records.push({
      event: recon,
      path: deriveProvenanceEventPath(recon),
    });
    expectNotComplete(input);
  });

  it("conflicting reconciliations", async () => {
    const fixture = await makeCompleteFixture();
    const input = cloneInput(fixture.input);
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-conflict",
      affectedOperationId: fixture.launchAttemptId,
      affectedOperationKind: "launch_attempt",
      payload: reconciliationSharedFields(),
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
    const recon = buildReconEvent(fixture, {
      resolutionId: "res-perm",
      affectedOperationId: fixture.runOpId,
      affectedOperationKind: "run_operation",
      payload: {
        resolutionKind: "operation_permanently_unresolvable",
        affectedOperationKind: "run_operation",
        affectedOperationId: fixture.runOpId,
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
        authoritativeResolutionInstant: "2026-07-15T14:00:00.000Z",
        producerSchemaVersion: "1",
        sourceRepositorySha: SOURCE_SHA,
        runnerSnapshotVersion: RUNNER_VERSION,
      },
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
