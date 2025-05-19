/**
 * Coverage lifecycle: activation → history proof → coverage snapshot → seal.
 * Append-only CAS persistence with public-safe outputs.
 */

import type { GitHubClient } from "../github/client.js";
import {
  buildPersistedActivationRecord,
  parsePersistedActivationRecord,
  type CanonicalActivationPayload,
  type PersistedActivationRecord,
  type RetrievedActivationSource,
} from "./activation-attestation.js";
import {
  verifyActivationHistoryProof,
  type ActivationHistoryProofRecord,
  type VerifiedActivationHistoryProof,
} from "./activation-history-proof.js";
import { loadGitHubCommitGraph } from "./commit-graph.js";
import {
  attemptOverlapsInterval,
  buildCoverageSnapshot,
  intervalsOverlap,
  projectAttempts,
  type CoverageInterval,
  type CoverageSnapshot,
} from "./coverage.js";
import {
  activationHistoryProofRecordDigest,
  buildActivationHistoryProofRecord,
  buildCoverageGapRecord,
  buildCoverageSealRecord,
  buildCoverageSupersessionRecord,
  buildDuplicateOperationIncidentRecord,
  buildEpochInvalidationRecord,
  buildPersistedCoverageSnapshotEnvelope,
  parseCoverageGapRecord,
  parseCoverageSealRecord,
  parseCoverageSupersessionRecord,
  parseDuplicateOperationIncidentRecord,
  parseEpochInvalidationRecord,
  parsePersistedCoverageSnapshotEnvelope,
  persistedActivationRecordDigest,
  type CoverageGapRecord,
  type CoverageSealRecord,
  type CoverageSupersessionRecord,
  type DuplicateOperationIncidentRecord,
  type EpochInvalidationRecord,
  type PersistedCoverageSnapshotEnvelope,
} from "./coverage-lifecycle-schemas.js";
import { CursorProvenanceError } from "./errors.js";
import type {
  CoverageIncompleteReason,
  ProvenanceEventRecord,
} from "./event-integrity.js";
import {
  activationHistoryProofRemotePath,
  activationRecordRemotePath,
  coverageGapRemotePath,
  coverageSealRemotePath,
  coverageSnapshotRemotePath,
  coverageSupersessionRemotePath,
  duplicateIncidentRemotePath,
  epochInvalidationRemotePath,
  provenanceEventsRootPrefix,
} from "./paths.js";
import type {
  LifecycleWritePolicy,
  ProvenanceLifecycleStore,
} from "./lifecycle-store.js";
import type { ProvenanceEventStore } from "./store.js";

export interface CoverageLifecycleServiceOptions {
  lifecycleStore: ProvenanceLifecycleStore;
  eventStore: ProvenanceEventStore;
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  stateRepository: string;
  writePolicy?: LifecycleWritePolicy;
}

export interface LifecycleWriteResult {
  idempotent: boolean;
  commitSha: string | null;
  path: string;
}

export interface ProvisionalCoverageInspection {
  epochId: string;
  interval: CoverageInterval;
  status: CoverageSnapshot["status"];
  incompleteReasons: CoverageIncompleteReason[];
  eventCount: number;
  activationCommitSha: string | null;
  eventSnapshotCommitSha: string | null;
  historyProofCommitSha: string | null;
}

export type PostSealEvidenceKind =
  | "provenance_event"
  | "reconciliation_resolution"
  | "gap_record"
  | "install_evidence"
  | "divergence_evidence"
  | "invalidation_record"
  | "supersession_record";

export interface PostSealEvidenceItem {
  kind: PostSealEvidenceKind;
  path: string;
  commitSha: string;
  overlapsSealedInterval: boolean;
  summary: string;
}

export interface SealToTipEnumeration {
  sealCommitSha: string;
  tipCommitSha: string;
  fullyEnumerated: boolean;
  items: PostSealEvidenceItem[];
  overlappingRawEvidenceCount: number;
  explicitInvalidationCount: number;
}

export class CoverageLifecycleService {
  constructor(private readonly options: CoverageLifecycleServiceOptions) {
    if (options.writePolicy) {
      const store =
        "configuredWritePolicy" in options.lifecycleStore
          ? options.lifecycleStore.configuredWritePolicy
          : null;
      if (store && store !== options.writePolicy) {
        throw new CursorProvenanceError(
          "cursor_provenance_config_invalid",
          `Lifecycle store policy mismatch (expected ${options.writePolicy}, got ${store}).`,
        );
      }
    }
  }

  async writeActivation(input: {
    epochId: string;
    payload: CanonicalActivationPayload;
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { record: PersistedActivationRecord }> {
    const record = buildPersistedActivationRecord(input.payload);
    const path = activationRecordRemotePath(input.epochId);
    const body = `${JSON.stringify(record, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: persistedActivationRecordDigest(record),
      commitMessage:
        input.commitMessage ?? `p-dev: coverage activation ${input.epochId}`,
    });
    return { ...result, path, record };
  }

  async writeHistoryProof(input: {
    epochId: string;
    activationCommitSha: string;
    eventSnapshotCommitSha: string;
    claimedRelationship?: ActivationHistoryProofRecord["claimedRelationship"];
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { record: ActivationHistoryProofRecord }> {
    await this.assertEventSnapshotExists(input.eventSnapshotCommitSha);

    const activationPath = activationRecordRemotePath(input.epochId);
    const activationBody = await this.options.lifecycleStore.loadRecord(
      activationPath,
    );
    if (!activationBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        "Activation record must exist before history proof.",
      );
    }
    parsePersistedActivationRecord(activationBody);

    const record = buildActivationHistoryProofRecord({
      stateRepository: this.options.stateRepository,
      stateBranch: this.options.branch,
      activationCommitSha: input.activationCommitSha,
      eventSnapshotCommitSha: input.eventSnapshotCommitSha,
      claimedRelationship: input.claimedRelationship ?? "unverified",
    });

    const graph = await loadGitHubCommitGraph({
      client: this.options.client,
      owner: this.options.owner,
      repo: this.options.repo,
      branch: this.options.branch,
      anchorShas: [
        input.activationCommitSha,
        input.eventSnapshotCommitSha,
      ],
    });
    const verified = verifyActivationHistoryProof({
      record,
      commitGraph: graph,
      expectedStateRepository: this.options.stateRepository,
      expectedStateBranch: this.options.branch,
    });
    if (!("__brand" in verified)) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        `Activation history proof invalid: ${verified.reason}`,
      );
    }

    const path = activationHistoryProofRemotePath(input.epochId);
    const body = `${JSON.stringify(record, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: activationHistoryProofRecordDigest(record),
      commitMessage:
        input.commitMessage ??
        `p-dev: activation history proof ${input.epochId}`,
    });
    return { ...result, path, record };
  }

  async writeCoverageSnapshot(input: {
    epochId: string;
    activationCommitSha: string;
    eventSnapshotCommitSha: string;
    activationHistoryProofCommitSha: string;
    activationHistoryProofDigest: string;
    snapshot: CoverageSnapshot;
    finalizationPolicyDigest?: string;
    commitMessage?: string;
  }): Promise<
    LifecycleWriteResult & { envelope: PersistedCoverageSnapshotEnvelope }
  > {
    await this.assertEventSnapshotExists(input.eventSnapshotCommitSha);

    const proofPath = activationHistoryProofRemotePath(input.epochId);
    const proofBody = await this.options.lifecycleStore.loadRecord(proofPath);
    if (!proofBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        "History proof must exist before coverage snapshot.",
      );
    }

    const envelope = buildPersistedCoverageSnapshotEnvelope(input);
    const path = coverageSnapshotRemotePath(input.epochId);
    const body = `${JSON.stringify(envelope, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: envelope.envelopeDigest,
      commitMessage:
        input.commitMessage ?? `p-dev: coverage snapshot ${input.epochId}`,
    });
    return { ...result, path, envelope };
  }

  async sealCoverage(input: {
    epochId: string;
    operatorToolSourceSha: string;
    finalizationEvidenceDigest: string;
    finalizationPolicyDigest?: string;
    coverageSnapshotCommitSha?: string;
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { seal: CoverageSealRecord }> {
    const snapshotPath = coverageSnapshotRemotePath(input.epochId);
    const snapshotBody =
      await this.options.lifecycleStore.loadRecord(snapshotPath);
    if (!snapshotBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        "Coverage snapshot must exist before seal.",
      );
    }
    const envelope = parsePersistedCoverageSnapshotEnvelope(snapshotBody);

    const proofPath = activationHistoryProofRemotePath(input.epochId);
    const proofBody = await this.options.lifecycleStore.loadRecordAtCommit(
      proofPath,
      envelope.activationHistoryProofCommitSha,
    );
    if (!proofBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "History proof missing at pinned commit.",
      );
    }
    const proofRecord = JSON.parse(proofBody) as ActivationHistoryProofRecord;
    const graph = await loadGitHubCommitGraph({
      client: this.options.client,
      owner: this.options.owner,
      repo: this.options.repo,
      branch: this.options.branch,
      anchorShas: [
        envelope.activationCommitSha,
        envelope.eventSnapshotCommitSha,
        envelope.activationHistoryProofCommitSha,
      ],
    });
    const verified = verifyActivationHistoryProof({
      record: proofRecord,
      commitGraph: graph,
      expectedStateRepository: this.options.stateRepository,
      expectedStateBranch: this.options.branch,
    });
    if (!("__brand" in verified)) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        `Persisted history proof invalid at seal: ${verified.reason}`,
      );
    }

    const snapshotAtCommit = await this.options.lifecycleStore.loadRecord(
      snapshotPath,
    );
    if (!snapshotAtCommit) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Coverage snapshot missing at seal validation.",
      );
    }
    parsePersistedCoverageSnapshotEnvelope(snapshotAtCommit);

    if (envelope.snapshot.status !== "complete") {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        "Cannot seal incomplete coverage interval.",
      );
    }

    const coverageSnapshotCommitSha =
      input.coverageSnapshotCommitSha ??
      (await this.resolveLatestCommitForPath(snapshotPath));
    if (!coverageSnapshotCommitSha) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Coverage snapshot commit SHA is required to seal.",
      );
    }

    const seal = buildCoverageSealRecord({
      epochId: input.epochId,
      interval: envelope.snapshot.interval,
      coverageDigest: envelope.snapshot.coverageDigest,
      activationCommitSha: envelope.activationCommitSha,
      eventSnapshotCommitSha: envelope.eventSnapshotCommitSha,
      activationHistoryProofCommitSha: envelope.activationHistoryProofCommitSha,
      activationHistoryProofDigest: envelope.activationHistoryProofDigest,
      coverageSnapshotCommitSha,
      coverageSnapshotDigest: envelope.envelopeDigest,
      finalizationEvidenceDigest: input.finalizationEvidenceDigest,
      operatorToolSourceSha: input.operatorToolSourceSha,
      finalizationPolicyDigest:
        input.finalizationPolicyDigest ?? envelope.finalizationPolicyDigest,
    });

    const path = coverageSealRemotePath(input.epochId);
    const body = `${JSON.stringify(seal, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: seal.sealDigest,
      commitMessage: input.commitMessage ?? `p-dev: coverage seal ${input.epochId}`,
    });
    return { ...result, path, seal };
  }

  async inspectProvisionalCoverage(input: {
    epochId: string;
    eventSnapshotCommitSha: string;
    activationRecord?: PersistedActivationRecord | null;
    activationSource?: RetrievedActivationSource | null;
    activationHistoryProof?: VerifiedActivationHistoryProof | null;
    reconciliationTimestamp?: string | null;
  }): Promise<ProvisionalCoverageInspection> {
    const records = await this.enumerateEvents(input.eventSnapshotCommitSha);
    const activationBody = await this.options.lifecycleStore.loadRecord(
      activationRecordRemotePath(input.epochId),
    );
    const activationRecord =
      input.activationRecord ??
      (activationBody
        ? parsePersistedActivationRecord(activationBody)
        : null);

    const interval =
      activationRecord?.payload.interval ??
      ({
        coverageStart: "1970-01-01T00:00:00.000Z",
        coverageEnd: "1970-01-01T00:00:01.000Z",
      } as CoverageInterval);

    const snapshot = buildCoverageSnapshot({
      interval,
      records,
      eventSnapshotSource: {
        stateRepository: this.options.stateRepository,
        stateBranch: this.options.branch,
        immutableCommitSha: input.eventSnapshotCommitSha,
      },
      activationRecord,
      activationSource: input.activationSource ?? null,
      activationHistoryProof: input.activationHistoryProof ?? null,
      reconciliationTimestamp: input.reconciliationTimestamp ?? null,
    });

    const proofPath = activationHistoryProofRemotePath(input.epochId);
    const proofCommit =
      (await this.resolveLatestCommitForPath(proofPath)) ?? null;

    return {
      epochId: input.epochId,
      interval,
      status: snapshot.status,
      incompleteReasons: snapshot.incompleteReasons,
      eventCount: records.length,
      activationCommitSha: input.activationSource?.immutableCommitSha ?? null,
      eventSnapshotCommitSha: input.eventSnapshotCommitSha,
      historyProofCommitSha: proofCommit,
    };
  }

  async reportGap(input: {
    epochId: string;
    intervalAttempted: CoverageInterval;
    incompleteReasons: CoverageIncompleteReason[];
    evidenceDigest: string;
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { gap: CoverageGapRecord }> {
    const gap = buildCoverageGapRecord(input);
    const path = coverageGapRemotePath(input.epochId, gap.gapDigest);
    const body = `${JSON.stringify(gap, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: gap.gapDigest,
      commitMessage: input.commitMessage ?? `p-dev: coverage gap ${input.epochId}`,
    });
    return { ...result, path, gap };
  }

  async supersedeAfterIrrecoverableGap(input: {
    priorSealCommitSha: string;
    priorSealDigest: string;
    reason: string;
    overlappingEvidenceDigest: string;
    newEpochId?: string | null;
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { supersession: CoverageSupersessionRecord }> {
    const supersession = buildCoverageSupersessionRecord({
      priorSealCommitSha: input.priorSealCommitSha,
      priorSealDigest: input.priorSealDigest,
      reason: input.reason,
      overlappingEvidenceDigest: input.overlappingEvidenceDigest,
      newEpochId: input.newEpochId ?? null,
    });
    const path = coverageSupersessionRemotePath(supersession.supersessionDigest);
    const body = `${JSON.stringify(supersession, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: supersession.supersessionDigest,
      commitMessage:
        input.commitMessage ?? "p-dev: coverage interval supersession",
    });
    return { ...result, path, supersession };
  }

  async reportDuplicateOperationIncident(input: {
    epochId: string;
    recoveryOperationId: string;
    stage: string;
    attemptOrdinal: number;
    duplicateOperationId: string;
    priorOperationId: string;
    recordedAt: string;
    commitMessage?: string;
  }): Promise<
    LifecycleWriteResult & { incident: DuplicateOperationIncidentRecord }
  > {
    const incident = buildDuplicateOperationIncidentRecord(input);
    const path = duplicateIncidentRemotePath(
      input.epochId,
      incident.incidentDigest,
    );
    const body = `${JSON.stringify(incident, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: incident.incidentDigest,
      commitMessage:
        input.commitMessage ??
        `p-dev: duplicate operation incident ${input.epochId}`,
    });
    return { ...result, path, incident };
  }

  async invalidateNeverSealedEpoch(input: {
    epochId: string;
    activationCommitSha: string;
    invalidInterval: CoverageInterval;
    reasons: string[];
    publicCanaryIdentities?: string[];
    workflowRunIds?: string[];
    eventCommitRange: {
      startCommitSha: string;
      endCommitSha: string;
    };
    gapId?: string | null;
    incidentId?: string | null;
    operatorToolSourceSha: string;
    improperPriorSeal?: {
      sealCommitSha: string;
      sealDigest: string;
      treatedAsValidCompleteSeal: false;
    };
    commitMessage?: string;
  }): Promise<LifecycleWriteResult & { invalidation: EpochInvalidationRecord }> {
    const invalidation = buildEpochInvalidationRecord(input);
    const path = epochInvalidationRemotePath(input.epochId);
    const body = `${JSON.stringify(invalidation, null, 2)}\n`;
    const result = await this.options.lifecycleStore.persistImmutableRecord({
      path,
      body,
      canonicalDigest: invalidation.invalidationDigest,
      commitMessage:
        input.commitMessage ??
        `p-dev: epoch invalidation ${input.epochId}`,
    });
    return { ...result, path, invalidation };
  }

  async loadEpochInvalidation(
    epochId: string,
  ): Promise<EpochInvalidationRecord | null> {
    const path = epochInvalidationRemotePath(epochId);
    const body = await this.options.lifecycleStore.loadRecord(path);
    if (!body) return null;
    return parseEpochInvalidationRecord(body);
  }

  async enumerateSealToTip(input: {
    sealCommitSha: string;
    tipCommitSha: string;
    sealedInterval: CoverageInterval;
  }): Promise<SealToTipEnumeration> {
    const items: PostSealEvidenceItem[] = [];
    let fullyEnumerated = true;

    // Prefer GitHub compare for seal→tip commit enumeration (O(delta), not
    // full event-tree materialization at tip). In-memory/test clients fall back.
    const compare = this.options.client?.compareCommits?.bind(
      this.options.client,
    );
    if (typeof compare === "function") {
      const comparison = await this.options.client.compareCommits(
        this.options.owner,
        this.options.repo,
        input.sealCommitSha,
        input.tipCommitSha,
      );
      if (comparison.status === "behind" || comparison.status === "diverged") {
        fullyEnumerated = false;
      } else if (comparison.status === "identical") {
        fullyEnumerated = true;
      } else {
        // ahead: GitHub compare returns at most 250 commits / 300 files.
        if (comparison.ahead_by > comparison.commits.length) {
          fullyEnumerated = false;
        }
        const eventsPrefix = `${provenanceEventsRootPrefix()}/`;
        const changed = comparison.files ?? [];
        for (const file of changed) {
          const path = file.filename;
          if (!path) continue;
          if (path.startsWith(eventsPrefix) && path.endsWith(".json")) {
            const content = await this.options.client.getRepositoryContent(
              this.options.owner,
              this.options.repo,
              path,
              input.tipCommitSha,
            );
            if (!content) {
              fullyEnumerated = false;
              continue;
            }
            const body = this.options.client.decodeRepositoryContent(content);
            let event: ProvenanceEventRecord["event"];
            try {
              event = JSON.parse(body) as ProvenanceEventRecord["event"];
            } catch {
              fullyEnumerated = false;
              continue;
            }
            const record: ProvenanceEventRecord = { path, event };
            items.push({
              kind:
                event.eventType === "reconciliation_resolution"
                  ? "reconciliation_resolution"
                  : "provenance_event",
              path,
              commitSha: input.tipCommitSha,
              overlapsSealedInterval: eventOverlapsInterval(
                record,
                input.sealedInterval,
              ),
              summary: event.eventType,
            });
          }
          if (path.includes("/gaps/")) {
            items.push({
              kind: "gap_record",
              path,
              commitSha: input.tipCommitSha,
              overlapsSealedInterval: true,
              summary: "coverage_gap",
            });
          }
          if (path.includes("/supersessions/")) {
            items.push({
              kind: "supersession_record",
              path,
              commitSha: input.tipCommitSha,
              overlapsSealedInterval: true,
              summary: "coverage_supersession",
            });
          }
          if (path.endsWith("/invalidation.json")) {
            items.push({
              kind: "invalidation_record",
              path,
              commitSha: input.tipCommitSha,
              overlapsSealedInterval: true,
              summary: "epoch_invalidation",
            });
          }
        }
      }
    } else {
      // In-memory / test stores: diff full event snapshots.
      const tipRecords = await this.enumerateEvents(input.tipCommitSha);
      const sealRecords = await this.enumerateEvents(input.sealCommitSha);
      const sealPaths = new Set(sealRecords.map((record) => record.path));
      for (const record of tipRecords) {
        if (sealPaths.has(record.path)) {
          continue;
        }
        const overlaps = eventOverlapsInterval(record, input.sealedInterval);
        items.push({
          kind:
            record.event.eventType === "reconciliation_resolution"
              ? "reconciliation_resolution"
              : "provenance_event",
          path: record.path,
          commitSha: input.tipCommitSha,
          overlapsSealedInterval: overlaps,
          summary: record.event.eventType,
        });
      }
    }

    const gapAndSupersessionItems =
      await this.enumerateLifecycleRecordsAfterSeal(input);
    items.push(...gapAndSupersessionItems);

    const overlappingRawEvidenceCount = detectOverlappingRawLateEvidence({
      sealedInterval: input.sealedInterval,
      items,
    }).length;
    const explicitInvalidationCount = items.filter(
      (item) =>
        item.kind === "invalidation_record" ||
        item.kind === "supersession_record",
    ).length;

    return {
      sealCommitSha: input.sealCommitSha,
      tipCommitSha: input.tipCommitSha,
      fullyEnumerated,
      items,
      overlappingRawEvidenceCount,
      explicitInvalidationCount,
    };
  }

  async enumerateEvents(
    eventSnapshotCommitSha: string,
  ): Promise<ProvenanceEventRecord[]> {
    if (!this.options.eventStore.enumerateEventSnapshotAtCommit) {
      throw new CursorProvenanceError(
        "cursor_provenance_state_unavailable",
        "Event store does not support enumeration.",
      );
    }
    return this.options.eventStore.enumerateEventSnapshotAtCommit(
      eventSnapshotCommitSha,
    );
  }

  private async assertEventSnapshotExists(
    eventSnapshotCommitSha: string,
  ): Promise<void> {
    const records = await this.enumerateEvents(eventSnapshotCommitSha);
    if (records.length === 0) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        "Event snapshot commit has no enumerated provenance events.",
      );
    }
  }

  async resolveLatestCommitForPath(path: string): Promise<string | null> {
    const store = this.options.lifecycleStore;
    if (
      "resolveCommitShaForPath" in store &&
      typeof store.resolveCommitShaForPath === "function"
    ) {
      return store.resolveCommitShaForPath(path);
    }
    if ("commitShaForPath" in store && typeof store.commitShaForPath === "function") {
      return store.commitShaForPath(path);
    }
    return null;
  }

  private async enumerateLifecycleRecordsAfterSeal(input: {
    sealedInterval: CoverageInterval;
  }): Promise<PostSealEvidenceItem[]> {
    const store = this.options.lifecycleStore;
    if (!("listPaths" in store) || typeof store.listPaths !== "function") {
      return [];
    }
    const items: PostSealEvidenceItem[] = [];
    const paths = [...store.listPaths()];
    for (const path of paths) {
      if (path.includes("/gaps/")) {
        const body = await store.loadRecord(path);
        if (!body) continue;
        const gap = parseCoverageGapRecord(body);
        items.push({
          kind: "gap_record",
          path,
          commitSha: store.commitShaForPath?.(path) ?? "unknown",
          overlapsSealedInterval: intervalsOverlap(
            gap.intervalAttempted.coverageStart,
            gap.intervalAttempted.coverageEnd,
            input.sealedInterval.coverageStart,
            input.sealedInterval.coverageEnd,
          ),
          summary: "coverage_gap",
        });
      }
      if (path.includes("/supersessions/")) {
        const body = await store.loadRecord(path);
        if (!body) continue;
        items.push({
          kind: "supersession_record",
          path,
          commitSha: store.commitShaForPath?.(path) ?? "unknown",
          overlapsSealedInterval: true,
          summary: "coverage_supersession",
        });
      }
      if (path.endsWith("/invalidation.json")) {
        const body = await store.loadRecord(path);
        if (!body) continue;
        items.push({
          kind: "invalidation_record",
          path,
          commitSha: store.commitShaForPath?.(path) ?? "unknown",
          overlapsSealedInterval: true,
          summary: "epoch_invalidation",
        });
      }
    }
    return items;
  }
}

export function eventOverlapsInterval(
  record: ProvenanceEventRecord,
  interval: CoverageInterval,
): boolean {
  const attempts = projectAttempts([record.event]);
  const attempt = attempts.find(
    (row) => row.launchAttemptId === record.event.launchAttemptId,
  );
  if (!attempt) {
    return intervalsOverlap(
      record.event.recordedAt,
      record.event.recordedAt,
      interval.coverageStart,
      interval.coverageEnd,
    );
  }
  return attemptOverlapsInterval(attempt, interval);
}

export function detectOverlappingRawLateEvidence(input: {
  sealedInterval: CoverageInterval;
  items: PostSealEvidenceItem[];
}): PostSealEvidenceItem[] {
  return input.items.filter(
    (item) =>
      item.overlapsSealedInterval &&
      (item.kind === "provenance_event" ||
        item.kind === "reconciliation_resolution" ||
        item.kind === "divergence_evidence"),
  );
}

export function sealInvalidatedByEnumeration(
  enumeration: SealToTipEnumeration,
): boolean {
  if (enumeration.overlappingRawEvidenceCount > 0) {
    return true;
  }
  return enumeration.explicitInvalidationCount > 0;
}

export {
  parseCoverageGapRecord,
  parseCoverageSealRecord,
  parseCoverageSupersessionRecord,
  parseDuplicateOperationIncidentRecord,
  parseEpochInvalidationRecord,
};
