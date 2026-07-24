import {
  parsePersistedActivationRecord,
  type PersistedActivationRecord,
} from "./activation-attestation.js";
import {
  parseActivationHistoryProofRecord,
  verifyActivationHistoryProof,
  type VerifiedActivationHistoryProof,
} from "./activation-history-proof.js";
import {
  isCommitAncestorViaCompare,
  loadGitHubCommitGraph,
} from "./commit-graph.js";
import {
  parsePersistedCoverageSnapshotEnvelope,
  parseCoverageSealRecord,
  type CoverageSealRecord,
  type PersistedCoverageSnapshotEnvelope,
} from "./coverage-lifecycle-schemas.js";
import {
  CoverageLifecycleService,
  sealInvalidatedByEnumeration,
} from "./coverage-lifecycle.js";
import { CursorProvenanceError } from "./errors.js";
import {
  activationHistoryProofRemotePath,
  activationRecordRemotePath,
  coverageSealRemotePath,
  coverageSnapshotRemotePath,
} from "./paths.js";
import type { ProvenanceLifecycleStore } from "./lifecycle-store.js";
import type { ProvenanceEventStore } from "./store.js";

export type AuthoritativeCoverageStatus =
  | "integrity_failure"
  | "invalidated"
  | "sealed_but_invalidated_by_later_evidence"
  | "sealed_complete"
  | "provisional_complete_unsealed"
  | "provisional_incomplete";

export interface AuthoritativeCoverageInspection {
  status: AuthoritativeCoverageStatus;
  epochId: string;
  sealCommitSha: string | null;
  sealDigest: string | null;
  activationCommitSha: string | null;
  eventSnapshotCommitSha: string | null;
  historyProofCommitSha: string | null;
  snapshotCommitSha: string | null;
  postSealFullyEnumerated: boolean;
  postSealInvalidatingCount: number;
  incompleteReasons: string[];
  detail?: string;
}

export interface AuthoritativeCoverageContext {
  service: CoverageLifecycleService;
  lifecycleStore: ProvenanceLifecycleStore;
  eventStore: ProvenanceEventStore;
  client: any;
  stateRepository: string;
  stateBranch: string;
  owner: string;
  repo: string;
}

export async function verifySealedArtifactsAtPinnedCommits(
  ctx: AuthoritativeCoverageContext,
  input: { epochId: string; sealCommitSha: string; seal: CoverageSealRecord; tipCommitSha: string },
): Promise<{
  activationRecord: PersistedActivationRecord;
  historyProof: VerifiedActivationHistoryProof;
  snapshotEnvelope: PersistedCoverageSnapshotEnvelope;
}> {
  const seal = input.seal;
  const epochId = input.epochId;

  const activationPath = activationRecordRemotePath(epochId);
  const activationBody = await ctx.lifecycleStore.loadRecordAtCommit(
    activationPath,
    seal.activationCommitSha,
  );
  if (!activationBody) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Activation record missing at pinned seal activation commit.",
    );
  }
  const activationRecord = parsePersistedActivationRecord(activationBody);
  if (activationRecord.payload.epochId !== epochId) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Activation epochId mismatch at pinned commit.",
    );
  }
  if (
    activationRecord.payload.stateRepository !== ctx.stateRepository ||
    activationRecord.payload.stateBranch !== ctx.stateBranch
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Activation state repository/branch mismatch.",
    );
  }

  const proofPath = activationHistoryProofRemotePath(epochId);
  const proofBody = await ctx.lifecycleStore.loadRecordAtCommit(
    proofPath,
    seal.activationHistoryProofCommitSha,
  );
  if (!proofBody) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "History proof missing at pinned seal proof commit.",
    );
  }
  const proofRecord = parseActivationHistoryProofRecord(proofBody);

  // Load only the sealed artifact ancestry chain — never walk tip→root.
  const graph = await loadGitHubCommitGraph({
    client: ctx.client as any,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.stateBranch,
    anchorShas: [
      input.sealCommitSha,
      seal.activationCommitSha,
      seal.eventSnapshotCommitSha,
      seal.activationHistoryProofCommitSha,
      seal.coverageSnapshotCommitSha,
    ],
    stopAtShas: [seal.activationCommitSha],
  });

  if (!graph.isEqualOrDescendant(seal.activationCommitSha, seal.eventSnapshotCommitSha)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Activation commit is not an ancestor of event snapshot commit.",
    );
  }
  if (!graph.isEqualOrDescendant(seal.eventSnapshotCommitSha, input.sealCommitSha)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Event snapshot commit is not an ancestor of seal commit.",
    );
  }
  let tipIsDescendant = false;
  if (typeof (ctx.client as { compareCommits?: unknown }).compareCommits === "function") {
    tipIsDescendant = await isCommitAncestorViaCompare({
      client: ctx.client as any,
      owner: ctx.owner,
      repo: ctx.repo,
      ancestorSha: input.sealCommitSha,
      descendantSha: input.tipCommitSha,
    });
  } else {
    // Test/in-memory clients: load tip ancestry stopping at seal.
    const tipGraph = await loadGitHubCommitGraph({
      client: ctx.client as any,
      owner: ctx.owner,
      repo: ctx.repo,
      branch: ctx.stateBranch,
      anchorShas: [input.tipCommitSha],
      stopAtShas: [input.sealCommitSha],
    });
    tipIsDescendant = tipGraph.isEqualOrDescendant(
      input.sealCommitSha,
      input.tipCommitSha,
    );
  }
  if (!tipIsDescendant) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Seal commit is not an ancestor of tip commit.",
    );
  }

  const verifiedProof = verifyActivationHistoryProof({
    record: proofRecord,
    commitGraph: graph,
    expectedStateRepository: ctx.stateRepository,
    expectedStateBranch: ctx.stateBranch,
  });
  if (!("__brand" in verifiedProof)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      `History proof verification failed: ${verifiedProof.reason}`,
    );
  }

  const snapshotPath = coverageSnapshotRemotePath(epochId);
  const snapshotBody = await ctx.lifecycleStore.loadRecordAtCommit(
    snapshotPath,
    seal.coverageSnapshotCommitSha,
  );
  if (!snapshotBody) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage snapshot missing at pinned seal snapshot commit.",
    );
  }
  const envelope = parsePersistedCoverageSnapshotEnvelope(snapshotBody);

  if (envelope.epochId !== epochId) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage snapshot epochId mismatch.",
    );
  }
  if (envelope.envelopeDigest !== seal.coverageSnapshotDigest) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage snapshot digest mismatch vs seal pin.",
    );
  }
  if (envelope.snapshot.coverageDigest !== seal.coverageDigest) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage digest mismatch vs seal pin.",
    );
  }
  if (
    envelope.activationCommitSha !== seal.activationCommitSha ||
    envelope.eventSnapshotCommitSha !== seal.eventSnapshotCommitSha ||
    envelope.activationHistoryProofCommitSha !== seal.activationHistoryProofCommitSha ||
    envelope.activationHistoryProofDigest !== seal.activationHistoryProofDigest
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Seal pin mismatch vs persisted coverage envelope.",
    );
  }
  if (
    envelope.snapshot.interval.coverageStart !== seal.interval.coverageStart ||
    envelope.snapshot.interval.coverageEnd !== seal.interval.coverageEnd
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage snapshot interval mismatch vs seal.",
    );
  }
  if (
    activationRecord.payload.interval.coverageStart !== seal.interval.coverageStart ||
    activationRecord.payload.interval.coverageEnd !== seal.interval.coverageEnd
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Activation interval mismatch vs seal.",
    );
  }

  const expectedPolicyDigest = activationRecord.payload.finalizationPolicy?.digest ?? null;
  const sealPolicyDigest = seal.finalizationPolicyDigest ?? null;
  const envelopePolicyDigest = envelope.finalizationPolicyDigest ?? null;
  if (!sealPolicyDigest || !/^[0-9a-f]{64}$/.test(sealPolicyDigest)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Seal is missing finalizationPolicyDigest.",
    );
  }
  if (expectedPolicyDigest && expectedPolicyDigest !== sealPolicyDigest) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Finalization policy digest mismatch vs activation pin.",
    );
  }
  if (envelopePolicyDigest && envelopePolicyDigest !== sealPolicyDigest) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Finalization policy digest mismatch vs snapshot envelope.",
    );
  }

  if (envelope.snapshot.status !== "complete") {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Persisted snapshot is not complete at pinned seal snapshot.",
    );
  }

  return {
    activationRecord,
    historyProof: verifiedProof,
    snapshotEnvelope: envelope,
  };
}

export async function inspectAuthoritativeEpochCoverage(
  ctx: AuthoritativeCoverageContext,
  input: { epochId: string },
): Promise<AuthoritativeCoverageInspection> {
  const epochId = input.epochId;
  const sealPath = coverageSealRemotePath(epochId);
  const tipCommitSha = (await ctx.client.getGitRef(ctx.owner, ctx.repo, ctx.stateBranch))
    .object.sha;

  const base: AuthoritativeCoverageInspection = {
    status: "provisional_incomplete",
    epochId,
    sealCommitSha: null,
    sealDigest: null,
    activationCommitSha: null,
    eventSnapshotCommitSha: null,
    historyProofCommitSha: null,
    snapshotCommitSha: null,
    postSealFullyEnumerated: false,
    postSealInvalidatingCount: 0,
    incompleteReasons: [],
  };

  const sealBodyAtTip = await ctx.lifecycleStore.loadRecord(sealPath);
  if (!sealBodyAtTip) {
    const inspection = await ctx.service.inspectProvisionalCoverage({
      epochId,
      eventSnapshotCommitSha: tipCommitSha,
    });
    return {
      ...base,
      status:
        inspection.status === "complete"
          ? "provisional_complete_unsealed"
          : "provisional_incomplete",
      activationCommitSha: inspection.activationCommitSha,
      eventSnapshotCommitSha: inspection.eventSnapshotCommitSha,
      historyProofCommitSha: inspection.historyProofCommitSha,
      incompleteReasons: inspection.incompleteReasons.map((r) => String(r)),
    };
  }

  try {
    const sealCommitSha = await ctx.service.resolveLatestCommitForPath(sealPath);
    if (!sealCommitSha) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Seal commit SHA could not be resolved.",
      );
    }
    const sealBody = await ctx.lifecycleStore.loadRecordAtCommit(sealPath, sealCommitSha);
    if (!sealBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Seal missing at pinned commit.",
      );
    }
    const seal = parseCoverageSealRecord(sealBody);

    const pinned = await verifySealedArtifactsAtPinnedCommits(ctx, {
      epochId,
      sealCommitSha,
      seal,
      tipCommitSha,
    });

    const enumeration = await ctx.service.enumerateSealToTip({
      sealCommitSha,
      tipCommitSha,
      sealedInterval: seal.interval,
    });

    const postSealInvalidatingCount =
      enumeration.overlappingRawEvidenceCount + enumeration.explicitInvalidationCount;

    if (!enumeration.fullyEnumerated) {
      return {
        ...base,
        status: "integrity_failure",
        sealCommitSha,
        sealDigest: seal.sealDigest,
        activationCommitSha: seal.activationCommitSha,
        eventSnapshotCommitSha: seal.eventSnapshotCommitSha,
        historyProofCommitSha: seal.activationHistoryProofCommitSha,
        snapshotCommitSha: seal.coverageSnapshotCommitSha,
        postSealFullyEnumerated: false,
        postSealInvalidatingCount,
        incompleteReasons: ["late_evidence_enumeration_incomplete"],
      };
    }

    const invalidation = await ctx.service.loadEpochInvalidation(epochId);
    if (invalidation) {
      return {
        ...base,
        status: "invalidated",
        sealCommitSha,
        sealDigest: seal.sealDigest,
        activationCommitSha: seal.activationCommitSha,
        eventSnapshotCommitSha: seal.eventSnapshotCommitSha,
        historyProofCommitSha: seal.activationHistoryProofCommitSha,
        snapshotCommitSha: seal.coverageSnapshotCommitSha,
        postSealFullyEnumerated: true,
        postSealInvalidatingCount,
        incompleteReasons: ["epoch_invalidated"],
      };
    }

    if (sealInvalidatedByEnumeration(enumeration)) {
      return {
        ...base,
        status: "sealed_but_invalidated_by_later_evidence",
        sealCommitSha,
        sealDigest: seal.sealDigest,
        activationCommitSha: seal.activationCommitSha,
        eventSnapshotCommitSha: seal.eventSnapshotCommitSha,
        historyProofCommitSha: seal.activationHistoryProofCommitSha,
        snapshotCommitSha: seal.coverageSnapshotCommitSha,
        postSealFullyEnumerated: true,
        postSealInvalidatingCount,
        incompleteReasons: ["sealed_interval_invalidated_by_late_evidence"],
      };
    }

    void pinned;
    return {
      ...base,
      status: "sealed_complete",
      sealCommitSha,
      sealDigest: seal.sealDigest,
      activationCommitSha: seal.activationCommitSha,
      eventSnapshotCommitSha: seal.eventSnapshotCommitSha,
      historyProofCommitSha: seal.activationHistoryProofCommitSha,
      snapshotCommitSha: seal.coverageSnapshotCommitSha,
      postSealFullyEnumerated: true,
      postSealInvalidatingCount,
      incompleteReasons: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      status: "integrity_failure",
      detail: message,
      incompleteReasons: ["coverage_integrity_failure"],
    };
  }
}

