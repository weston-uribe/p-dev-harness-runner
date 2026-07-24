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
  buildPersistedCoverageSnapshotEnvelope,
  parseCoverageGapRecord,
  parseCoverageSealRecord,
  parseCoverageSupersessionRecord,
  parsePersistedCoverageSnapshotEnvelope,
  persistedActivationRecordDigest,
  type CoverageGapRecord,
  type CoverageSealRecord,
  type CoverageSupersessionRecord,
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
} from "./paths.js";
import type { ProvenanceLifecycleStore } from "./lifecycle-store.js";
import type { ProvenanceEventStore } from "./store.js";

export interface CoverageLifecycleServiceOptions {
  lifecycleStore: ProvenanceLifecycleStore;
  eventStore: ProvenanceEventStore;
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  stateRepository: string;
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
  constructor(private readonly options: CoverageLifecycleServiceOptions) {}

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

  async enumerateSealToTip(input: {
    sealCommitSha: string;
    tipCommitSha: string;
    sealedInterval: CoverageInterval;
  }): Promise<SealToTipEnumeration> {
    const tipRecords = await this.enumerateEvents(input.tipCommitSha);
    const sealRecords = await this.enumerateEvents(input.sealCommitSha);
    const sealPaths = new Set(sealRecords.map((record) => record.path));

    const items: PostSealEvidenceItem[] = [];
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
      fullyEnumerated: true,
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
};
