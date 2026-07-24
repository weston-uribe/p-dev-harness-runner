import { describe, expect, it, vi } from "vitest";
import { CoverageLifecycleService } from "../../src/provenance/coverage-lifecycle.js";
import { buildPersistedActivationRecord } from "../../src/provenance/activation-attestation.js";
import { ACTIVATION_HISTORY_PROOF_KIND } from "../../src/provenance/activation-history-proof.js";
import { activationHistoryProofRecordDigest } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { buildLiveActivationPayload } from "../../src/provenance/live-activation.js";
import { InMemoryProvenanceLifecycleStore } from "../../src/provenance/lifecycle-store.js";
import { finalizeEpoch } from "../../src/provenance/operator-coverage.js";
import { buildLaunchIntentEvent } from "../../src/provenance/events.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import {
  activationHistoryProofRemotePath,
  activationRecordRemotePath,
  coverageSealRemotePath,
  coverageSnapshotRemotePath,
  deriveProvenanceEventPath,
} from "../../src/provenance/paths.js";

const STATE_REPO = "weston-uribe/p-dev-harness-state";
const STATE_BRANCH = "p-dev-runtime-state";
const EPOCH = "epoch-finalize-1";
const CAPTURE_SHA = "c".repeat(40);
const RUNNER_SHA = "b".repeat(40);

const ACTIVATION_COMMIT = "a".repeat(40);
const EVENT_COMMIT = "b".repeat(40);
const PROOF_COMMIT = "c".repeat(40);
const SNAPSHOT_COMMIT = "d".repeat(40);
const SEAL_COMMIT = "e".repeat(40);
const TIP_COMMIT = "f".repeat(40);
const BASE_RECORDED_AT = "2026-07-21T00:00:00.000Z";
const FINALIZATION_POLICY_DIGEST = "a".repeat(64);

function loopbackClient() {
  const commits = [
    { sha: ACTIVATION_COMMIT, parents: [] as string[], treeSha: "tree-a" },
    { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT], treeSha: "tree-b" },
    { sha: PROOF_COMMIT, parents: [EVENT_COMMIT], treeSha: "tree-c" },
    { sha: SNAPSHOT_COMMIT, parents: [PROOF_COMMIT], treeSha: "tree-d" },
    { sha: SEAL_COMMIT, parents: [SNAPSHOT_COMMIT], treeSha: "tree-e" },
    { sha: TIP_COMMIT, parents: [SEAL_COMMIT], treeSha: "tree-f" },
  ];
  const commitMap = new Map(
    commits.map((c) => [
      c.sha,
      { sha: c.sha, tree: { sha: c.treeSha }, parents: c.parents.map((sha) => ({ sha })) },
    ]),
  );
  return {
    getGitCommit: vi.fn(async (_o: string, _r: string, sha: string) => {
      const commit = commitMap.get(sha);
      if (!commit) throw new Error(`missing commit ${sha}`);
      return commit;
    }),
    getGitRef: vi.fn(async () => ({ object: { sha: TIP_COMMIT } })),
  };
}

function recordFor(eventType: "launch_intent", recordedAt: string) {
  const launchContext = createLinearHarnessLaunchContext({
    operatorWorkspaceId: "ws",
    sourceProjectId: "proj",
    linearIssueId: "issue",
    linearIssueKey: "KEY-1",
    phase: "implementation",
    phaseExecutionId: null,
    harnessRunId: "run",
    providerOperationId: "a".repeat(64),
    agentRole: "builder",
    action: "create",
    generation: 1,
    priorAgentHash: null,
    targetRepository: "weston-uribe/p-dev-harness-state",
    startingRef: "main",
    prUrl: null,
    prNumber: null,
    orchestratorMarker: "marker",
    orchestratorMarkerVersion: "1",
    sourceRepositorySha: CAPTURE_SHA,
    runnerSnapshotVersion: RUNNER_SHA,
    workflowRunId: null,
    launchSurface: "implementation.initial_create",
  });
  const event = buildLaunchIntentEvent({
    launchAttemptId: "ab".repeat(32),
    launchContext,
    recordedAt,
  });
  return { path: deriveProvenanceEventPath(event), event };
}

function fakeEventStore(recordsByCommit: Record<string, Array<{ path: string; event: any }>>) {
  return {
    enumerateEventSnapshotAtCommit: vi.fn(async (commitSha: string) => {
      return recordsByCommit[commitSha] ?? [];
    }),
  } as any;
}

function forcePathCommitSha(store: InMemoryProvenanceLifecycleStore, path: string, sha: string) {
  store["commitByPath"].set(path, sha);
}

async function seedSealedEpoch() {
  const lifecycleStore = new InMemoryProvenanceLifecycleStore();
  const client = loopbackClient();
  const eventStore = fakeEventStore({
    [EVENT_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
    [SEAL_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
    [TIP_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
  });
  const service = new CoverageLifecycleService({
    lifecycleStore,
    eventStore,
    client: client as any,
    owner: "weston-uribe",
    repo: "p-dev-harness-state",
    branch: STATE_BRANCH,
    stateRepository: STATE_REPO,
  });

  const payload = buildLiveActivationPayload({
    epochId: EPOCH,
    activatedAt: "2026-07-10T00:00:00.000Z",
    interval: {
      coverageStart: "2026-07-10T00:00:00.000Z",
      coverageEnd: "2026-07-20T00:00:00.000Z",
    },
    captureProducerSourceSha: CAPTURE_SHA,
    productionRunnerSha: RUNNER_SHA,
  });
  await service.writeActivation({ epochId: EPOCH, payload });
  forcePathCommitSha(lifecycleStore, activationRecordRemotePath(EPOCH), ACTIVATION_COMMIT);

  const proof = await service.writeHistoryProof({
    epochId: EPOCH,
    activationCommitSha: ACTIVATION_COMMIT,
    eventSnapshotCommitSha: EVENT_COMMIT,
    claimedRelationship: "descendant",
  });
  forcePathCommitSha(lifecycleStore, activationHistoryProofRemotePath(EPOCH), PROOF_COMMIT);
  const proofDigest = activationHistoryProofRecordDigest(proof.record);

  const snapshot = buildCoverageSnapshot({
    interval: payload.interval,
    records: await eventStore.enumerateEventSnapshotAtCommit(EVENT_COMMIT),
    eventSnapshotSource: {
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      immutableCommitSha: EVENT_COMMIT,
    },
    activationRecord: buildPersistedActivationRecord(payload),
    activationSource: {
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      activationRecordPath: activationRecordRemotePath(EPOCH),
      immutableCommitSha: ACTIVATION_COMMIT,
    },
    activationHistoryProof: {
      __brand: "VerifiedActivationHistoryProof",
      kind: ACTIVATION_HISTORY_PROOF_KIND,
      version: "1",
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      relationship: "descendant",
      verifierVersion: "cursor-activation-history-verifier-v1",
      evidenceDigest: proofDigest,
      verifiedAt: "2026-07-20T00:00:00.000Z",
    } as any,
  });
  await service.writeCoverageSnapshot({
    epochId: EPOCH,
    activationCommitSha: ACTIVATION_COMMIT,
    eventSnapshotCommitSha: EVENT_COMMIT,
    activationHistoryProofCommitSha: PROOF_COMMIT,
    activationHistoryProofDigest: proofDigest,
    snapshot,
    finalizationPolicyDigest: FINALIZATION_POLICY_DIGEST,
  });
  forcePathCommitSha(lifecycleStore, coverageSnapshotRemotePath(EPOCH), SNAPSHOT_COMMIT);

  await service.sealCoverage({
    epochId: EPOCH,
    operatorToolSourceSha: "o".repeat(40),
    finalizationEvidenceDigest: "e".repeat(64),
    finalizationPolicyDigest: FINALIZATION_POLICY_DIGEST,
    coverageSnapshotCommitSha: SNAPSHOT_COMMIT,
  });
  forcePathCommitSha(lifecycleStore, coverageSealRemotePath(EPOCH), SEAL_COMMIT);

  const ctx = {
    service,
    lifecycleStore,
    eventStore,
    client: client as any,
    stateRepository: STATE_REPO,
    stateBranch: STATE_BRANCH,
    owner: "weston-uribe",
    repo: "p-dev-harness-state",
  } as any;

  return { ctx, lifecycleStore, client };
}

describe("finalizeEpoch resumable + verify_existing_only", () => {
  it("adopts an already sealed_complete epoch with zero writes", async () => {
    const { ctx } = await seedSealedEpoch();
    const result = await finalizeEpoch(ctx, {
      epochId: EPOCH,
      operatorToolSourceSha: "o".repeat(40),
      writePolicy: "create_or_adopt",
    });
    expect(result.sealed).toBe(true);
    if (result.sealed) {
      expect(result.adoptedSeal).toBe(true);
      expect(result.adoptedProof).toBe(true);
      expect(result.adoptedSnapshot).toBe(true);
      expect(result.writeCount).toBe(0);
    }
  });

  it("verify_existing_only: sealed epoch adopts with writeAttemptCount 0 and writeCount 0", async () => {
    const { ctx, lifecycleStore } = await seedSealedEpoch();
    (lifecycleStore as { writePolicy: string }).writePolicy =
      "verify_existing_only";
    (lifecycleStore as { writeAttemptCounter: number }).writeAttemptCounter = 0;

    const result = await finalizeEpoch(ctx, {
      epochId: EPOCH,
      operatorToolSourceSha: "o".repeat(40),
      writePolicy: "verify_existing_only",
    });
    expect(result.sealed).toBe(true);
    if (result.sealed) {
      expect(result.adoptedProof).toBe(true);
      expect(result.adoptedSnapshot).toBe(true);
      expect(result.adoptedSeal).toBe(true);
      expect(result.writeCount).toBe(0);
      expect(result.writeAttemptCount).toBe(0);
      expect(result.wouldWriteKinds).toEqual([]);
    }
  });

  it("verify_existing_only: missing seal/proof/snapshot returns wouldWriteKinds with zero writes", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore({
      writePolicy: "verify_existing_only",
    });
    const client = loopbackClient();
    const eventStore = fakeEventStore({
      [TIP_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
    });
    const service = new CoverageLifecycleService({
      lifecycleStore,
      eventStore,
      client: client as any,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: STATE_BRANCH,
      stateRepository: STATE_REPO,
    });
    const ctx = {
      service,
      lifecycleStore,
      eventStore,
      client: client as any,
      stateRepository: STATE_REPO,
      stateBranch: STATE_BRANCH,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
    } as any;

    const result = await finalizeEpoch(ctx, {
      epochId: EPOCH,
      operatorToolSourceSha: "o".repeat(40),
      writePolicy: "verify_existing_only",
    });
    expect(result.sealed).toBe(false);
    if (!result.sealed) {
      expect(result.wouldWriteKinds).toEqual(
        expect.arrayContaining(["history_proof", "snapshot", "seal"]),
      );
      expect(result.writeCount).toBe(0);
    }
  });
});

