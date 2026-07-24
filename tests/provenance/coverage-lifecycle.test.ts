import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_ATTESTATION_SCHEMA_KIND,
  buildPersistedActivationRecord,
  type CanonicalActivationPayload,
} from "../../src/provenance/activation-attestation.js";
import {
  ACTIVATION_HISTORY_PROOF_KIND,
  createLoopbackCommitGraph,
} from "../../src/provenance/activation-history-proof.js";
import {
  CoverageLifecycleService,
  detectOverlappingRawLateEvidence,
  eventOverlapsInterval,
  sealInvalidatedByEnumeration,
} from "../../src/provenance/coverage-lifecycle.js";
import { activationHistoryProofRecordDigest } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { buildCoverageSnapshot } from "../../src/provenance/coverage.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";
import { generateProvenanceKey, parseProvenanceKey } from "../../src/provenance/encryption.js";
import {
  InMemoryProvenanceLifecycleStore,
} from "../../src/provenance/lifecycle-store.js";
import {
  activationRecordRemotePath,
  coverageSealRemotePath,
} from "../../src/provenance/paths.js";
import {
  GithubProvenanceEventStore,
  InMemoryProvenanceEventStore,
} from "../../src/provenance/store.js";
import { PROVENANCE_WRITER_VERSION } from "../../src/provenance/launch-surfaces.js";
import {
  productionLaunchSurfacesManifestPin,
  productionSendSurfacesManifestPin,
} from "../../src/provenance/activation-attestation.js";
import {
  getExpectedRunnerDeploymentSlots,
  getProductionWorkflowInstallManifest,
  productionRunnerInstallManifestPin,
  productionWorkflowInstallManifestPin,
  runnerInstallationId,
  workflowEntrypointKey,
} from "../../src/provenance/production-install-manifests.js";
import {
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
} from "../../src/provenance/launch-surfaces.js";
import type { ProvenanceEventRecord } from "../../src/provenance/event-integrity.js";

const DIGEST = "d".repeat(64);
const INTERVAL = {
  coverageStart: "2026-07-10T00:00:00.000Z",
  coverageEnd: "2026-07-20T00:00:00.000Z",
} as const;
const STATE_REPO = "weston-uribe/p-dev-harness-state";
const STATE_BRANCH = "p-dev-runtime-state";
const ACTIVATION_COMMIT = "b".repeat(40);
const EVENT_COMMIT = "c".repeat(40);
const PROOF_COMMIT = "e".repeat(40);
const SNAPSHOT_COMMIT = "f".repeat(40);
const SEAL_COMMIT = "a".repeat(40);
const EPOCH = "epoch-test-1";

function buildActivationPayload(): CanonicalActivationPayload {
  const workflowPin = productionWorkflowInstallManifestPin();
  const runnerPin = productionRunnerInstallManifestPin();
  const workflowManifest = getProductionWorkflowInstallManifest();
  const slots = getExpectedRunnerDeploymentSlots();
  const installedFrom = "2026-06-01T00:00:00.000Z";

  return {
    kind: ACTIVATION_ATTESTATION_SCHEMA_KIND,
    version: "1",
    epochId: EPOCH,
    activatedAt: installedFrom,
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
    sourceShaAllowlist: ["a".repeat(40)],
    runnerSnapshotVersionAllowlist: ["runner-snap-1"],
    workflowInstallAttestations: workflowManifest.entrypoints.map((ep) => ({
      entrypointKey: workflowEntrypointKey(ep),
      workflowId: ep.workflowId,
      workflowVersion: "1",
      installedFrom,
      installedUntil: null,
      evidenceDigest: DIGEST,
    })),
    surfaceInstallAttestations: [
      ...PRODUCTION_LAUNCH_SURFACES.map((surface) => ({
        kind: "launch" as const,
        surface,
        installedFrom,
        installedUntil: null,
        evidenceDigest: DIGEST,
      })),
      ...PRODUCTION_SEND_SURFACES.map((surface) => ({
        kind: "send" as const,
        surface,
        installedFrom,
        installedUntil: null,
        evidenceDigest: DIGEST,
      })),
    ],
    runnerVersionInstallAttestations: slots.map((slot) => ({
      installationId: runnerInstallationId(slot),
      runnerSnapshotVersion: "runner-snap-1",
      installedFrom,
      installedUntil: null,
      evidenceDigest: DIGEST,
    })),
    stateRepository: STATE_REPO,
    stateBranch: STATE_BRANCH,
    lifecycleRecords: [
      {
        lifecycleKind: "activation",
        epochId: EPOCH,
        effectiveAt: installedFrom,
        reasonCode: "activated",
        producerSchemaVersion: "1",
        evidenceSource: "operator_attestation",
        evidenceDigest: DIGEST,
      },
    ],
    knownWriterOutagesOrGaps: [],
  };
}

function loopbackClient(commits: Array<{ sha: string; parents: string[]; treeSha?: string }>) {
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
  const trees = new Map<string, { truncated?: boolean; entries: Array<{ path: string }> }>();

  return {
    getGitCommit: vi.fn(async (_o: string, _r: string, sha: string) => {
      const commit = commitMap.get(sha);
      if (!commit) {
        throw new Error(`missing commit ${sha}`);
      }
      return commit;
    }),
    getGitTree: vi.fn(
      async (input: { treeSha: string; recursive?: boolean }) => {
        const tree = trees.get(input.treeSha);
        if (!tree) {
          return { sha: input.treeSha, tree: [], truncated: false };
        }
        return {
          sha: input.treeSha,
          tree: tree.entries.map((entry) => ({
            path: entry.path,
            mode: "100644",
            type: "blob" as const,
            sha: "blob",
          })),
          truncated: tree.truncated ?? false,
        };
      },
    ),
    getRepositoryContent: vi.fn(),
    decodeRepositoryContent: (content: { content: string }) =>
      Buffer.from(content.content, "base64").toString("utf8"),
    registerTree(treeSha: string, entries: Array<{ path: string }>, truncated = false) {
      trees.set(treeSha, { entries, truncated });
    },
  };
}

function lifecycleService(input: {
  lifecycleStore: InMemoryProvenanceLifecycleStore;
  eventStore: InMemoryProvenanceEventStore;
  client?: ReturnType<typeof loopbackClient>;
}) {
  const client =
    input.client ??
    loopbackClient([
      { sha: ACTIVATION_COMMIT, parents: [] },
      { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT] },
      { sha: PROOF_COMMIT, parents: [EVENT_COMMIT] },
      { sha: SNAPSHOT_COMMIT, parents: [PROOF_COMMIT] },
      { sha: SEAL_COMMIT, parents: [SNAPSHOT_COMMIT] },
    ]);
  return new CoverageLifecycleService({
    lifecycleStore: input.lifecycleStore,
    eventStore: input.eventStore,
    client: client as never,
    owner: "weston-uribe",
    repo: "p-dev-harness-state",
    branch: STATE_BRANCH,
    stateRepository: STATE_REPO,
  });
}

describe("coverage lifecycle foundation", () => {
  it("CAS idempotent retry and divergence on digest mismatch", async () => {
    const store = new InMemoryProvenanceLifecycleStore();
    const payload = buildActivationPayload();
    const record = buildPersistedActivationRecord(payload);
    const path = activationRecordRemotePath(EPOCH);
    const body = `${JSON.stringify(record, null, 2)}\n`;

    const first = await store.persistImmutableRecord({
      path,
      body,
      canonicalDigest: record.canonicalPayloadDigest,
      commitMessage: "p-dev: coverage activation",
    });
    expect(first.idempotent).toBe(false);

    const second = await store.persistImmutableRecord({
      path,
      body,
      canonicalDigest: record.canonicalPayloadDigest,
      commitMessage: "p-dev: coverage activation retry",
    });
    expect(second.idempotent).toBe(true);

    const divergent = buildPersistedActivationRecord({
      ...payload,
      activatedAt: "2026-06-02T00:00:00.000Z",
    });
    await expect(
      store.persistImmutableRecord({
        path,
        body: `${JSON.stringify(divergent, null, 2)}\n`,
        canonicalDigest: divergent.canonicalPayloadDigest,
        commitMessage: "p-dev: divergent activation",
      }),
    ).rejects.toBeInstanceOf(CursorProvenanceError);
  });

  it("history proof cannot succeed before event snapshot exists", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const eventStore = new InMemoryProvenanceEventStore();
    const service = lifecycleService({ lifecycleStore, eventStore });

    const activation = await service.writeActivation({
      epochId: EPOCH,
      payload: buildActivationPayload(),
    });
    expect(activation.idempotent).toBe(false);

    await expect(
      service.writeHistoryProof({
        epochId: EPOCH,
        activationCommitSha: ACTIVATION_COMMIT,
        eventSnapshotCommitSha: EVENT_COMMIT,
      }),
    ).rejects.toBeInstanceOf(CursorProvenanceError);
  });

  it("seal pins all lifecycle commit SHAs", async () => {
    const lifecycleStore = new InMemoryProvenanceLifecycleStore();
    const eventStore = new InMemoryProvenanceEventStore();
    const client = loopbackClient([
      { sha: ACTIVATION_COMMIT, parents: [], treeSha: "tree-activation" },
      { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT], treeSha: "tree-events" },
      { sha: PROOF_COMMIT, parents: [EVENT_COMMIT] },
      { sha: SNAPSHOT_COMMIT, parents: [PROOF_COMMIT] },
      { sha: SEAL_COMMIT, parents: [SNAPSHOT_COMMIT] },
    ]);

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
      sourceRepositorySha: "a".repeat(40),
      runnerSnapshotVersion: "runner-snap-1",
      launchContext: {} as never,
    });

    const service = lifecycleService({ lifecycleStore, eventStore, client });

    await service.writeActivation({
      epochId: EPOCH,
      payload: buildActivationPayload(),
    });

    const proof = await service.writeHistoryProof({
      epochId: EPOCH,
      activationCommitSha: ACTIVATION_COMMIT,
      eventSnapshotCommitSha: EVENT_COMMIT,
      claimedRelationship: "descendant",
    });
    expect(proof.commitSha).toBeTruthy();

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
          activationRecord: buildPersistedActivationRecord(buildActivationPayload()),
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

    expect(seal.seal.activationCommitSha).toBe(ACTIVATION_COMMIT);
    expect(seal.seal.eventSnapshotCommitSha).toBe(EVENT_COMMIT);
    expect(seal.seal.activationHistoryProofCommitSha).toBe(PROOF_COMMIT);
    expect(seal.seal.activationHistoryProofDigest).toBe(proofDigest);
    expect(seal.seal.coverageSnapshotCommitSha).toBe(SNAPSHOT_COMMIT);
    expect(seal.seal.coverageSnapshotDigest).toBe(
      snapshotWrite.envelope.envelopeDigest,
    );
    await expect(
      lifecycleStore.loadRecord(coverageSealRemotePath(EPOCH)),
    ).resolves.toBeTruthy();
  });

  it("event tree truncation fails closed", async () => {
    const client = loopbackClient([
      { sha: EVENT_COMMIT, parents: [], treeSha: "tree-truncated" },
    ]);
    client.registerTree("tree-truncated", [{ path: "events/a.json" }], true);

    const store = new GithubProvenanceEventStore({
      client: client as never,
      owner: "o",
      repo: "r",
      branch: STATE_BRANCH,
      autoCreateBranch: true,
    });

    await expect(
      store.enumerateEventSnapshotAtCommit(EVENT_COMMIT),
    ).rejects.toMatchObject({
      code: "cursor_provenance_coverage_integrity_error",
    });
  });

  it("detects overlapping raw late evidence helpers", () => {
    const interval = { ...INTERVAL };
    const record: ProvenanceEventRecord = {
      path: ".p-dev/cursor-cloud-agent-provenance/events/x/launch_intent.json",
      event: {
        launchAttemptId: "x".repeat(64),
        eventType: "launch_intent",
        schemaKind: "p-dev.cursor-cloud-agent-provenance.v1",
        schemaVersion: "1",
        eventId: "e".repeat(64),
        transitionId: "launch_intent",
        canonicalSemanticDigest: DIGEST,
        launchContextDigest: DIGEST,
        recordedAt: "2026-07-15T00:00:00.000Z",
        writerVersion: PROVENANCE_WRITER_VERSION,
        sourceRepositorySha: "a".repeat(40),
        runnerSnapshotVersion: "runner-snap-1",
        launchContext: {} as never,
      },
    };

    expect(eventOverlapsInterval(record, interval)).toBe(true);

    const overlapping = detectOverlappingRawLateEvidence({
      sealedInterval: interval,
      items: [
        {
          kind: "provenance_event",
          path: record.path,
          commitSha: "tip",
          overlapsSealedInterval: true,
          summary: "launch_intent",
        },
        {
          kind: "gap_record",
          path: "gap",
          commitSha: "tip",
          overlapsSealedInterval: true,
          summary: "gap",
        },
      ],
    });
    expect(overlapping).toHaveLength(1);
    expect(
      sealInvalidatedByEnumeration({
        sealCommitSha: "seal",
        tipCommitSha: "tip",
        fullyEnumerated: true,
        items: overlapping,
        overlappingRawEvidenceCount: 1,
        explicitInvalidationCount: 0,
      }),
    ).toBe(true);
  });

  it("generateProvenanceKey matches parseProvenanceKey contract", () => {
    const key = generateProvenanceKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseProvenanceKey(key);
    expect(parsed.length).toBe(32);
  });

  it("loopback commit graph still verifies history proofs", () => {
    const graph = createLoopbackCommitGraph({
      repository: STATE_REPO,
      branch: STATE_BRANCH,
      edges: [
        { sha: ACTIVATION_COMMIT, parents: [] },
        { sha: EVENT_COMMIT, parents: [ACTIVATION_COMMIT] },
      ],
    });
    expect(
      graph.isEqualOrDescendant(ACTIVATION_COMMIT, EVENT_COMMIT),
    ).toBe(true);
  });
});
