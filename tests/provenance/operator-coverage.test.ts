import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_HISTORY_PROOF_KIND,
  createLoopbackCommitGraph,
} from "../../src/provenance/activation-history-proof.js";
import { buildPersistedActivationRecord } from "../../src/provenance/activation-attestation.js";
import { CoverageLifecycleService } from "../../src/provenance/coverage-lifecycle.js";
import { activationHistoryProofRecordDigest } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { buildLiveActivationPayload } from "../../src/provenance/live-activation.js";
import { InMemoryProvenanceLifecycleStore } from "../../src/provenance/lifecycle-store.js";
import {
  activationRecordRemotePath,
  coverageSealRemotePath,
} from "../../src/provenance/paths.js";
import { PROVENANCE_WRITER_VERSION } from "../../src/provenance/launch-surfaces.js";
import {
  InMemoryProvenanceEventStore,
} from "../../src/provenance/store.js";

const DIGEST = "d".repeat(64);
const INTERVAL = {
  coverageStart: "2026-07-10T00:00:00.000Z",
  coverageEnd: "2026-07-20T00:00:00.000Z",
} as const;
const STATE_REPO = "weston-uribe/p-dev-harness-state";
const STATE_BRANCH = "p-dev-runtime-state";
const EPOCH = "epoch-operator-1";
const CAPTURE_SHA = "a".repeat(40);
const RUNNER_SHA = "runner-snap-1";
const ACTIVATION_COMMIT = "b".repeat(40);
const EVENT_COMMIT = "c".repeat(40);
const PROOF_COMMIT = "e".repeat(40);
const SNAPSHOT_COMMIT = "f".repeat(40);

function loopbackClient() {
  const commits = [
    { sha: ACTIVATION_COMMIT, parents: [], treeSha: "tree-activation" },
    { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT], treeSha: "tree-events" },
    { sha: PROOF_COMMIT, parents: [EVENT_COMMIT] },
    { sha: SNAPSHOT_COMMIT, parents: [PROOF_COMMIT] },
  ];
  const commitMap = new Map(
    commits.map((commit) => [
      commit.sha,
      {
        sha: commit.sha,
        tree: { sha: commit.treeSha ?? `tree-${commit.sha}` },
        parents: commit.parents.map((sha) => ({ sha })),
      },
    ]),
  );
  const trees = new Map<string, { entries: Array<{ path: string }> }>();
  return {
    getGitCommit: vi.fn(async (_o: string, _r: string, sha: string) => {
      const commit = commitMap.get(sha);
      if (!commit) throw new Error(`missing commit ${sha}`);
      return commit;
    }),
    getGitTree: vi.fn(async (input: { treeSha: string }) => {
      const tree = trees.get(input.treeSha);
      return {
        sha: input.treeSha,
        tree: (tree?.entries ?? []).map((entry) => ({
          path: entry.path,
          mode: "100644",
          type: "blob" as const,
          sha: "blob",
        })),
        truncated: false,
      };
    }),
    getRepositoryContent: vi.fn(),
    getGitRef: vi.fn(async () => ({ object: { sha: EVENT_COMMIT } })),
    decodeRepositoryContent: (content: { content: string }) =>
      Buffer.from(content.content, "base64").toString("utf8"),
    registerTree(treeSha: string, entries: Array<{ path: string }>) {
      trees.set(treeSha, { entries });
    },
  };
}

describe("operator coverage orchestration", () => {
  it("activate then finalize seals complete coverage in memory", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const eventStore = new InMemoryProvenanceEventStore();
    const client = loopbackClient();
    const eventPath =
      ".p-dev/cursor-cloud-agent-provenance/events/ab/launch_intent.json";
    client.registerTree("tree-events", [{ path: eventPath }]);
    eventStore["events"].set(eventPath, {
      launchAttemptId: "ab".repeat(32),
      eventType: "launch_intent",
      schemaKind: "p-dev.cursor-cloud-agent-provenance.v1",
      schemaVersion: "1",
      eventId: "e".repeat(64),
      transitionId: "launch_intent",
      canonicalSemanticDigest: DIGEST,
      launchContextDigest: DIGEST,
      recordedAt: "2026-07-15T00:00:00.000Z",
      writerVersion: PROVENANCE_WRITER_VERSION,
      sourceRepositorySha: CAPTURE_SHA,
      runnerSnapshotVersion: RUNNER_SHA,
      launchContext: {} as never,
    });

    const service = new CoverageLifecycleService({
      lifecycleStore,
      eventStore,
      client: client as never,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: STATE_BRANCH,
      stateRepository: STATE_REPO,
    });

    const payload = buildLiveActivationPayload({
      epochId: EPOCH,
      activatedAt: "2026-06-01T00:00:00.000Z",
      interval: { ...INTERVAL },
      captureProducerSourceSha: CAPTURE_SHA,
      productionRunnerSha: RUNNER_SHA,
    });
    const activation = await service.writeActivation({ epochId: EPOCH, payload });
    expect(activation.idempotent).toBe(false);

    const activationCommitSha =
      activation.commitSha ??
      lifecycleStore.commitShaForPath(activationRecordRemotePath(EPOCH));
    expect(activationCommitSha).toBeTruthy();

    const proof = await service.writeHistoryProof({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      claimedRelationship: "descendant",
    });
    const proofDigest = activationHistoryProofRecordDigest(proof.record);
    const snapshotWrite = await service.writeCoverageSnapshot({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      activationHistoryProofCommitSha: PROOF_COMMIT,
      activationHistoryProofDigest: proofDigest,
      snapshot: {
        ...buildCoverageSnapshot({
          interval: { ...INTERVAL },
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
          },
        }),
        status: "complete",
        incompleteReasons: [],
      },
    });

    const seal = await service.sealCoverage({
      epochId: EPOCH,
      operatorToolSourceSha: "op".repeat(40),
      finalizationEvidenceDigest: DIGEST,
      coverageSnapshotCommitSha: SNAPSHOT_COMMIT,
    });

    expect(seal.seal.coverageSnapshotDigest).toBe(
      snapshotWrite.envelope.envelopeDigest,
    );
    await expect(
      lifecycleStore.loadRecord(coverageSealRemotePath(EPOCH)),
    ).resolves.toBeTruthy();

    const graph = createLoopbackCommitGraph({
      repository: STATE_REPO,
      branch: STATE_BRANCH,
      edges: [
        { sha: ACTIVATION_COMMIT, parents: [] },
        { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT] },
      ],
    });
    expect(graph.isEqualOrDescendant(ACTIVATION_COMMIT, EVENT_COMMIT)).toBe(
      true,
    );
  });
});
