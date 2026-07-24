import { describe, expect, it, vi } from "vitest";
import { buildPersistedActivationRecord } from "../../src/provenance/activation-attestation.js";
import { ACTIVATION_HISTORY_PROOF_KIND } from "../../src/provenance/activation-history-proof.js";
import { CoverageLifecycleService } from "../../src/provenance/coverage-lifecycle.js";
import { activationHistoryProofRecordDigest } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { inspectAuthoritativeEpochCoverage } from "../../src/provenance/authoritative-coverage-inspect.js";
import {
  buildLaunchIntentEvent,
  buildProviderCallStartedEvent,
} from "../../src/provenance/events.js";
import { buildLiveActivationPayload } from "../../src/provenance/live-activation.js";
import { InMemoryProvenanceLifecycleStore } from "../../src/provenance/lifecycle-store.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import {
  activationHistoryProofRemotePath,
  activationRecordRemotePath,
  coverageSealRemotePath,
  coverageSnapshotRemotePath,
  deriveProvenanceEventPath,
  epochInvalidationRemotePath,
} from "../../src/provenance/paths.js";

const STATE_REPO = "weston-uribe/p-dev-harness-state";
const STATE_BRANCH = "p-dev-runtime-state";
const EPOCH = "epoch-auth-1";
const CAPTURE_SHA = "c".repeat(40);
const RUNNER_SHA = "b".repeat(40);

const ACTIVATION_COMMIT = "a".repeat(40);
const EVENT_COMMIT = "b".repeat(40);
const PROOF_COMMIT = "c".repeat(40);
const SNAPSHOT_COMMIT = "d".repeat(40);
const SEAL_COMMIT = "e".repeat(40);
const TIP_COMMIT = "f".repeat(40);
const BASE_RECORDED_AT = "2026-07-21T00:00:00.000Z";
const LATE_RECORDED_AT = "2026-07-15T00:00:00.000Z";
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
    commits.map((commit) => [
      commit.sha,
      {
        sha: commit.sha,
        tree: { sha: commit.treeSha },
        parents: commit.parents.map((sha) => ({ sha })),
      },
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

const LAUNCH_ATTEMPT_ID = "ab".repeat(32);
const LAUNCH_CONTEXT = createLinearHarnessLaunchContext({
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

function recordFor(eventType: "launch_intent" | "provider_call_started", recordedAt: string) {
  const event =
    eventType === "launch_intent"
      ? buildLaunchIntentEvent({
          launchAttemptId: LAUNCH_ATTEMPT_ID,
          launchContext: LAUNCH_CONTEXT,
          recordedAt,
        })
      : buildProviderCallStartedEvent({
          launchAttemptId: LAUNCH_ATTEMPT_ID,
          launchContext: LAUNCH_CONTEXT,
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

describe("inspectAuthoritativeEpochCoverage", () => {
  it("returns sealed_complete for a verified seal with no invalidating evidence", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const client = loopbackClient();
    const eventStore = fakeEventStore({
      [SEAL_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
      [TIP_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
      [EVENT_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
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

    const proof = await service.writeHistoryProof({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      claimedRelationship: "descendant",
    });
    forcePathCommitSha(
      lifecycleStore,
      activationHistoryProofRemotePath(EPOCH),
      PROOF_COMMIT,
    );
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

    const snapshotWrite = await service.writeCoverageSnapshot({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      activationHistoryProofCommitSha: PROOF_COMMIT,
      activationHistoryProofDigest: proofDigest,
      snapshot,
      finalizationPolicyDigest: FINALIZATION_POLICY_DIGEST,
    });
    forcePathCommitSha(
      lifecycleStore,
      coverageSnapshotRemotePath(EPOCH),
      SNAPSHOT_COMMIT,
    );

    const seal = await service.sealCoverage({
      epochId: EPOCH,
      operatorToolSourceSha: "o".repeat(40),
      finalizationEvidenceDigest: "e".repeat(64),
      finalizationPolicyDigest: FINALIZATION_POLICY_DIGEST,
      coverageSnapshotCommitSha: SNAPSHOT_COMMIT,
    });
    void seal;
    forcePathCommitSha(lifecycleStore, coverageSealRemotePath(EPOCH), SEAL_COMMIT);

    const inspection = await inspectAuthoritativeEpochCoverage(
      {
        service,
        lifecycleStore,
        eventStore,
        client: client as any,
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        owner: "weston-uribe",
        repo: "p-dev-harness-state",
      } as any,
      { epochId: EPOCH },
    );

    expect(inspection.status).toBe("sealed_complete");
    expect(inspection.sealCommitSha).toBe(SEAL_COMMIT);
    expect(inspection.postSealInvalidatingCount).toBe(0);
  });

  it("returns invalidated when an epoch invalidation record exists", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const client = loopbackClient();
    const eventStore = fakeEventStore({
      [SEAL_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
      [TIP_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
      [EVENT_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
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

    // Minimal sealed artifacts for inspect path.
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
    await service.writeHistoryProof({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      claimedRelationship: "descendant",
    });
    forcePathCommitSha(lifecycleStore, activationHistoryProofRemotePath(EPOCH), PROOF_COMMIT);

    const proofBody = await lifecycleStore.loadRecord(activationHistoryProofRemotePath(EPOCH));
    const proofRecord = proofBody ? (JSON.parse(proofBody) as any) : null;
    const proofDigest = activationHistoryProofRecordDigest(proofRecord);

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

    await service.invalidateNeverSealedEpoch({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      invalidInterval: payload.interval,
      reasons: ["coverage_start_precedes_activation"],
      eventCommitRange: { startCommitSha: ACTIVATION_COMMIT, endCommitSha: EVENT_COMMIT },
      operatorToolSourceSha: "o".repeat(40),
    });
    forcePathCommitSha(lifecycleStore, epochInvalidationRemotePath(EPOCH), TIP_COMMIT);

    const inspection = await inspectAuthoritativeEpochCoverage(
      {
        service,
        lifecycleStore,
        eventStore,
        client: client as any,
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        owner: "weston-uribe",
        repo: "p-dev-harness-state",
      } as any,
      { epochId: EPOCH },
    );
    expect(inspection.status).toBe("invalidated");
  });

  it("returns sealed_but_invalidated_by_later_evidence when late overlapping evidence exists", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const client = loopbackClient();
    const eventStore = fakeEventStore({
      [SEAL_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
      [TIP_COMMIT]: [
        recordFor("launch_intent", BASE_RECORDED_AT),
        recordFor("provider_call_started", LATE_RECORDED_AT),
      ],
      [EVENT_COMMIT]: [recordFor("launch_intent", BASE_RECORDED_AT)],
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
    await service.writeHistoryProof({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      claimedRelationship: "descendant",
    });
    forcePathCommitSha(lifecycleStore, activationHistoryProofRemotePath(EPOCH), PROOF_COMMIT);
    const proofBody = await lifecycleStore.loadRecord(activationHistoryProofRemotePath(EPOCH));
    const proofRecord = proofBody ? (JSON.parse(proofBody) as any) : null;
    const proofDigest = activationHistoryProofRecordDigest(proofRecord);

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

    const inspection = await inspectAuthoritativeEpochCoverage(
      {
        service,
        lifecycleStore,
        eventStore,
        client: client as any,
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        owner: "weston-uribe",
        repo: "p-dev-harness-state",
      } as any,
      { epochId: EPOCH },
    );
    expect(inspection.status).toBe("sealed_but_invalidated_by_later_evidence");
    expect(inspection.postSealInvalidatingCount).toBeGreaterThan(0);
  });

  it("returns integrity_failure on malformed seal record", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const client = loopbackClient();
    const eventStore = fakeEventStore({
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

    lifecycleStore["records"].set(coverageSealRemotePath(EPOCH), "{");
    forcePathCommitSha(lifecycleStore, coverageSealRemotePath(EPOCH), SEAL_COMMIT);

    const inspection = await inspectAuthoritativeEpochCoverage(
      {
        service,
        lifecycleStore,
        eventStore,
        client: client as any,
        stateRepository: STATE_REPO,
        stateBranch: STATE_BRANCH,
        owner: "weston-uribe",
        repo: "p-dev-harness-state",
      } as any,
      { epochId: EPOCH },
    );
    expect(inspection.status).toBe("integrity_failure");
  });
});

