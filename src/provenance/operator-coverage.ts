/**
 * High-level operator orchestration for coverage lifecycle epochs.
 */

import { createHash } from "node:crypto";
import { GitHubClient } from "../github/client.js";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";
import {
  buildPersistedActivationRecord,
  parsePersistedActivationRecord,
  type RetrievedActivationSource,
} from "./activation-attestation.js";
import {
  ACTIVATION_HISTORY_PROOF_KIND,
  verifyActivationHistoryProof,
} from "./activation-history-proof.js";
import { loadGitHubCommitGraph } from "./commit-graph.js";
import { buildCoverageSnapshot } from "./coverage.js";
import {
  CoverageLifecycleService,
  type ProvisionalCoverageInspection,
  type SealToTipEnumeration,
} from "./coverage-lifecycle.js";
import {
  activationHistoryProofRecordDigest,
  parsePersistedCoverageSnapshotEnvelope,
} from "./coverage-lifecycle-schemas.js";
import { CursorProvenanceError } from "./errors.js";
import {
  GithubProvenanceLifecycleStore,
} from "./lifecycle-store.js";
import { buildLiveActivationPayload } from "./live-activation.js";
import {
  activationHistoryProofRemotePath,
  activationRecordRemotePath,
  coverageSealRemotePath,
} from "./paths.js";
import {
  GithubProvenanceEventStore,
} from "./store.js";

export interface OperatorCoverageContext {
  service: CoverageLifecycleService;
  lifecycleStore: GithubProvenanceLifecycleStore;
  eventStore: GithubProvenanceEventStore;
  client: GitHubClient;
  stateRepository: string;
  stateBranch: string;
  owner: string;
  repo: string;
}

function digestPrefix(digest: string): string {
  return digest.slice(0, 12);
}

function finalizationEvidenceDigest(input: {
  epochId: string;
  operatorToolSourceSha: string;
  eventSnapshotCommitSha: string;
}): string {
  return createHash("sha256")
    .update(
      `p-dev.finalization-evidence.v1|${input.epochId}|${input.operatorToolSourceSha}|${input.eventSnapshotCommitSha}`,
      "utf8",
    )
    .digest("hex");
}

export function createOperatorCoverageContext(input?: {
  env?: Record<string, string | undefined>;
  githubToken?: string;
}): OperatorCoverageContext {
  const env = input?.env ?? process.env;
  const repoParts = resolveWorkflowStateRepository(env);
  const token = input?.githubToken?.trim() || resolveStateGithubToken(env);
  if (!repoParts) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "P_DEV_WORKFLOW_STATE_REPOSITORY is required for operator coverage.",
    );
  }
  if (!token) {
    throw new CursorProvenanceError(
      "cursor_provenance_bootstrap_auth_failed",
      "State GitHub token is required for operator coverage.",
    );
  }
  const branch = resolveWorkflowStateBranch(env);
  const stateRepository = `${repoParts.owner}/${repoParts.repo}`;
  const client = new GitHubClient({ token });
  const lifecycleStore = new GithubProvenanceLifecycleStore({
    client,
    owner: repoParts.owner,
    repo: repoParts.repo,
    branch,
  });
  const eventStore = new GithubProvenanceEventStore({
    client,
    owner: repoParts.owner,
    repo: repoParts.repo,
    branch,
  });
  const service = new CoverageLifecycleService({
    lifecycleStore,
    eventStore,
    client,
    owner: repoParts.owner,
    repo: repoParts.repo,
    branch,
    stateRepository,
  });
  return {
    service,
    lifecycleStore,
    eventStore,
    client,
    stateRepository,
    stateBranch: branch,
    owner: repoParts.owner,
    repo: repoParts.repo,
  };
}

export async function activateEpoch(
  ctx: OperatorCoverageContext,
  input: {
    epochId: string;
    coverageStart: string;
    coverageEnd: string;
    captureProducerSourceSha: string;
    productionRunnerSha: string;
    activatedAt?: string;
  },
): Promise<{
  epochId: string;
  activationCommitSha: string | null;
  payloadDigestPrefix: string;
}> {
  const activatedAt = input.activatedAt ?? new Date().toISOString();
  const payload = buildLiveActivationPayload({
    epochId: input.epochId,
    activatedAt,
    interval: {
      coverageStart: input.coverageStart,
      coverageEnd: input.coverageEnd,
    },
    captureProducerSourceSha: input.captureProducerSourceSha,
    productionRunnerSha: input.productionRunnerSha,
    stateRepository: ctx.stateRepository,
    stateBranch: ctx.stateBranch,
  });
  const record = buildPersistedActivationRecord(payload);
  const result = await ctx.service.writeActivation({
    epochId: input.epochId,
    payload,
  });
  const activationCommitSha =
    result.commitSha ??
    (await ctx.service.resolveLatestCommitForPath(
      activationRecordRemotePath(input.epochId),
    ));
  return {
    epochId: input.epochId,
    activationCommitSha,
    payloadDigestPrefix: digestPrefix(record.canonicalPayloadDigest),
  };
}

export async function inspectEpoch(
  ctx: OperatorCoverageContext,
  input: {
    epochId: string;
    eventSnapshotCommitSha?: string;
  },
): Promise<ProvisionalCoverageInspection> {
  const eventSnapshotCommitSha =
    input.eventSnapshotCommitSha ??
    (await resolveStateTipSha(ctx));
  return ctx.service.inspectProvisionalCoverage({
    epochId: input.epochId,
    eventSnapshotCommitSha,
  });
}

export async function enumeratePostSeal(
  ctx: OperatorCoverageContext,
  input: {
    epochId: string;
    sealCommitSha?: string;
  },
): Promise<SealToTipEnumeration> {
  const sealPath = coverageSealRemotePath(input.epochId);
  const sealBody = await ctx.lifecycleStore.loadRecord(sealPath);
  if (!sealBody) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Coverage seal not found for epoch.",
    );
  }
  const sealCommitSha =
    input.sealCommitSha ??
    (await ctx.service.resolveLatestCommitForPath(sealPath));
  if (!sealCommitSha) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Seal commit SHA could not be resolved.",
    );
  }
  const seal = JSON.parse(sealBody) as { interval: { coverageStart: string; coverageEnd: string } };
  const tipCommitSha = await resolveStateTipSha(ctx);
  return ctx.service.enumerateSealToTip({
    sealCommitSha,
    tipCommitSha,
    sealedInterval: seal.interval,
  });
}

export async function finalizeEpoch(
  ctx: OperatorCoverageContext,
  input: {
    epochId: string;
    eventSnapshotCommitSha?: string;
    operatorToolSourceSha: string;
    finalizationEvidenceDigest?: string;
  },
): Promise<
  | {
      sealed: true;
      epochId: string;
      sealCommitSha: string | null;
      sealDigestPrefix: string;
      snapshotCommitSha: string | null;
      snapshotDigestPrefix: string;
      proofCommitSha: string | null;
      proofDigestPrefix: string;
      activationCommitSha: string;
      eventSnapshotCommitSha: string;
    }
  | {
      sealed: false;
      epochId: string;
      gapCommitSha: string | null;
      gapDigestPrefix: string;
      incompleteReasons: string[];
      activationCommitSha: string;
      eventSnapshotCommitSha: string;
      proofCommitSha: string | null;
      snapshotCommitSha: string | null;
    }
> {
  const eventSnapshotCommitSha =
    input.eventSnapshotCommitSha ?? (await resolveStateTipSha(ctx));
  const activationPath = activationRecordRemotePath(input.epochId);
  const activationCommitSha =
    await ctx.service.resolveLatestCommitForPath(activationPath);
  if (!activationCommitSha) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Activation record commit SHA could not be resolved.",
    );
  }

  const activationBody = await ctx.lifecycleStore.loadRecordAtCommit(
    activationPath,
    activationCommitSha,
  );
  if (!activationBody) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Activation record missing at pinned commit.",
    );
  }
  const activationRecord = parsePersistedActivationRecord(activationBody);
  const activationSource: RetrievedActivationSource = {
    stateRepository: ctx.stateRepository,
    stateBranch: ctx.stateBranch,
    activationRecordPath: activationPath,
    immutableCommitSha: activationCommitSha,
  };

  const proofWrite = await ctx.service.writeHistoryProof({
    epochId: input.epochId,
    activationCommitSha,
    eventSnapshotCommitSha,
    claimedRelationship: "descendant",
  });
  const proofCommitSha =
    proofWrite.commitSha ??
    (await ctx.service.resolveLatestCommitForPath(
      activationHistoryProofRemotePath(input.epochId),
    ));
  if (!proofCommitSha) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "History proof commit SHA could not be resolved.",
    );
  }
  const proofDigest = activationHistoryProofRecordDigest(proofWrite.record);

  const records = await ctx.service.enumerateEvents(eventSnapshotCommitSha);
  const graph = await loadGitHubCommitGraph({
    client: ctx.client,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.stateBranch,
    anchorShas: [activationCommitSha, eventSnapshotCommitSha, proofCommitSha],
  });
  const verifiedProof = verifyActivationHistoryProof({
    record: proofWrite.record,
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

  const snapshot = buildCoverageSnapshot({
    interval: activationRecord.payload.interval,
    records,
    eventSnapshotSource: {
      stateRepository: ctx.stateRepository,
      stateBranch: ctx.stateBranch,
      immutableCommitSha: eventSnapshotCommitSha,
    },
    activationRecord,
    activationSource,
    activationHistoryProof: verifiedProof,
  });

  const snapshotWrite = await ctx.service.writeCoverageSnapshot({
    epochId: input.epochId,
    activationCommitSha,
    eventSnapshotCommitSha,
    activationHistoryProofCommitSha: proofCommitSha,
    activationHistoryProofDigest: proofDigest,
    snapshot,
  });
  const snapshotCommitSha =
    snapshotWrite.commitSha ??
    (await ctx.service.resolveLatestCommitForPath(
      snapshotWrite.path,
    ));

  const reloaded = await ctx.lifecycleStore.loadRecord(snapshotWrite.path);
  if (!reloaded) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Coverage snapshot missing after write.",
    );
  }
  const envelope = parsePersistedCoverageSnapshotEnvelope(reloaded);

  if (envelope.snapshot.status !== "complete") {
    const evidenceDigest = createHash("sha256")
      .update(
        `p-dev.coverage-gap.v1|${input.epochId}|${eventSnapshotCommitSha}`,
        "utf8",
      )
      .digest("hex");
    const gap = await ctx.service.reportGap({
      epochId: input.epochId,
      intervalAttempted: activationRecord.payload.interval,
      incompleteReasons: envelope.snapshot.incompleteReasons,
      evidenceDigest,
    });
    return {
      sealed: false,
      epochId: input.epochId,
      gapCommitSha: gap.commitSha,
      gapDigestPrefix: digestPrefix(gap.gap.gapDigest),
      incompleteReasons: envelope.snapshot.incompleteReasons,
      activationCommitSha,
      eventSnapshotCommitSha,
      proofCommitSha,
      snapshotCommitSha,
    };
  }

  const finalDigest =
    input.finalizationEvidenceDigest ??
    finalizationEvidenceDigest({
      epochId: input.epochId,
      operatorToolSourceSha: input.operatorToolSourceSha,
      eventSnapshotCommitSha,
    });

  const seal = await ctx.service.sealCoverage({
    epochId: input.epochId,
    operatorToolSourceSha: input.operatorToolSourceSha,
    finalizationEvidenceDigest: finalDigest,
    coverageSnapshotCommitSha: snapshotCommitSha ?? undefined,
  });

  return {
    sealed: true,
    epochId: input.epochId,
    sealCommitSha: seal.commitSha,
    sealDigestPrefix: digestPrefix(seal.seal.sealDigest),
    snapshotCommitSha,
    snapshotDigestPrefix: digestPrefix(snapshotWrite.envelope.envelopeDigest),
    proofCommitSha,
    proofDigestPrefix: digestPrefix(proofDigest),
    activationCommitSha,
    eventSnapshotCommitSha,
  };
}

async function resolveStateTipSha(ctx: OperatorCoverageContext): Promise<string> {
  const ref = await ctx.client.getGitRef(ctx.owner, ctx.repo, ctx.stateBranch);
  return ref.object.sha;
}

export { ACTIVATION_HISTORY_PROOF_KIND };
