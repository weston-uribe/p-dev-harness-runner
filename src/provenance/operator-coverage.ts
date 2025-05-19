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
  parseActivationHistoryProofRecord,
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
  buildActivationReadinessRecord,
  parseActivationReadinessRecord,
  parsePersistedCoverageSnapshotEnvelope,
} from "./coverage-lifecycle-schemas.js";
import {
  inspectAuthoritativeEpochCoverage,
} from "./authoritative-coverage-inspect.js";
import { CursorProvenanceError } from "./errors.js";
import {
  GithubProvenanceLifecycleStore,
} from "./lifecycle-store.js";
import { buildLiveActivationPayload } from "./live-activation.js";
import {
  activationGuardExpiredAt,
  validateActivationGuard,
} from "./activation-guard.js";
import { resolveProvenanceMode } from "./mode.js";
import {
  DEFAULT_FINALIZATION_POLICY,
  finalizePolicyDigest,
  operatorFinalizeEvidenceDigest,
  pinFinalizationPolicy,
  quietWindowEvidenceDigest,
  type FinalizationPolicy,
} from "./finalization-policy.js";
import {
  DEFAULT_QUIET_WINDOW_POLL_GAP_MS,
  waitAndInspectQuietWindow,
  type QuietWindowObservation,
} from "./quiet-window.js";
import {
  activationHistoryProofRemotePath,
  activationReadinessRemotePath,
  activationRecordRemotePath,
  coverageSealRemotePath,
  coverageSnapshotRemotePath,
} from "./paths.js";
import {
  GithubProvenanceEventStore,
} from "./store.js";

/** Claimed history relationship for activation ↔ event snapshot tip. */
export function claimActivationHistoryRelationship(
  activationCommitSha: string,
  eventSnapshotCommitSha: string,
): "equal" | "descendant" {
  return activationCommitSha === eventSnapshotCommitSha ? "equal" : "descendant";
}

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

function commitTimestampFromDetail(detail: {
  commit?: {
    committer?: { date?: string | null } | null;
    author?: { date?: string | null } | null;
  };
}): string | null {
  const committer = detail.commit?.committer?.date ?? null;
  const author = detail.commit?.author?.date ?? null;
  return committer ?? author ?? null;
}

async function resolveCommitTimestampOrThrow(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  sha: string;
}): Promise<string> {
  const getCommit = (input.client as any).getCommit as
    | undefined
    | ((owner: string, repo: string, sha: string) => Promise<unknown>);
  if (!getCommit) {
    throw new CursorProvenanceError(
      "cursor_provenance_state_unavailable",
      "GitHub client does not support commit timestamp resolution.",
    );
  }
  const detail = (await getCommit(input.owner, input.repo, input.sha)) as any;
  const timestamp = commitTimestampFromDetail(detail);
  if (!timestamp) {
    throw new CursorProvenanceError(
      "cursor_provenance_state_unavailable",
      "Commit timestamp missing from GitHub response.",
    );
  }
  return timestamp;
}

export function createOperatorCoverageContext(input?: {
  env?: Record<string, string | undefined>;
  githubToken?: string;
  writePolicy?: "create_or_adopt" | "verify_existing_only";
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
    writePolicy: input?.writePolicy,
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
    requireFutureEffective?: boolean;
    activationCommitTimestamp?: string;
    requiredModeVerifiedAt?: string | null;
    isolationCheckCompletedAt?: string | null;
    minGuardDurationMs?: number;
    finalizationPolicy?: FinalizationPolicy;
  },
): Promise<{
  epochId: string;
  activationCommitSha: string | null;
  payloadDigestPrefix: string;
}> {
  const activatedAt = input.activatedAt ?? new Date().toISOString();
  const minGuardDurationMs = input.minGuardDurationMs ?? 0;

  if (input.requireFutureEffective) {
    const guard = validateActivationGuard({
      activationCommitTimestamp:
        input.activationCommitTimestamp ?? new Date().toISOString(),
      activatedAt,
      requiredModeVerifiedAt: input.requiredModeVerifiedAt,
      isolationCheckCompletedAt: input.isolationCheckCompletedAt,
      minGuardDurationMs,
    });
    if (guard.expired) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        `Activation guard expired before write: ${guard.reasons.join(",")}`,
      );
    }
  }

  const policyPin = pinFinalizationPolicy(
    input.finalizationPolicy ?? DEFAULT_FINALIZATION_POLICY,
  );
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
  payload.finalizationPolicy = policyPin;
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

  if (input.requireFutureEffective && activationCommitSha) {
    const actualCommitTimestamp =
      input.activationCommitTimestamp ??
      (await resolveCommitTimestampOrThrow({
        client: ctx.client,
        owner: ctx.owner,
        repo: ctx.repo,
        sha: activationCommitSha,
      }));
    const guard = validateActivationGuard({
      activationCommitTimestamp: actualCommitTimestamp,
      activatedAt,
      requiredModeVerifiedAt: input.requiredModeVerifiedAt,
      isolationCheckCompletedAt: input.isolationCheckCompletedAt,
      minGuardDurationMs,
    });
    if (!guard.ok) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_incomplete",
        `Activation guard failed after write: ${guard.reasons.join(",")} commit=${activationCommitSha}`,
      );
    }
  }
  void activationGuardExpiredAt(activatedAt, minGuardDurationMs);
  return {
    epochId: input.epochId,
    activationCommitSha,
    payloadDigestPrefix: digestPrefix(record.canonicalPayloadDigest),
  };
}

export async function confirmActivationReadinessRequired(
  ctx: OperatorCoverageContext,
  input: {
    epochId: string;
    minGuardDurationMs: number;
    contractVersion?: string;
    runnerRepository?: string;
    pollGapMs?: number;
    env?: Record<string, string | undefined>;
    now?: () => string;
    quietWindow?: {
      waitAndInspectQuietWindow: typeof waitAndInspectQuietWindow;
    };
  },
): Promise<{
  epochId: string;
  activationCommitSha: string;
  activatedAt: string;
  cutoff: string;
  readinessPath: string;
  readinessCommitSha: string | null;
  readinessDigestPrefix: string;
  verificationObservedAt: string;
  isolationEvidenceDigestPrefix: string;
}> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date().toISOString());
  const mode = resolveProvenanceMode(env);
  if (mode !== "required") {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      "Activation readiness confirmation requires provenance mode required.",
    );
  }

  const activationPath = activationRecordRemotePath(input.epochId);
  const activationCommitSha =
    (await ctx.service.resolveLatestCommitForPath(activationPath)) ??
    ctx.lifecycleStore.commitShaForPath?.(activationPath);
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
  const activation = parsePersistedActivationRecord(activationBody);
  const activatedAt = activation.payload.activatedAt;
  const cutoff = activationGuardExpiredAt(activatedAt, input.minGuardDurationMs);
  const nowIso = now();
  if (Date.parse(nowIso) >= Date.parse(cutoff)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Activation readiness confirmation missed cutoff.",
    );
  }
  if (Date.parse(nowIso) >= Date.parse(activatedAt)) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      "Activation readiness confirmation must occur before activatedAt.",
    );
  }

  const waitAndInspect =
    input.quietWindow?.waitAndInspectQuietWindow ?? waitAndInspectQuietWindow;
  const pollGapMs = input.pollGapMs ?? DEFAULT_QUIET_WINDOW_POLL_GAP_MS;
  const quiet = await waitAndInspect({
    client: ctx.client,
    runnerRepository: input.runnerRepository,
    stateRepository: { owner: ctx.owner, repo: ctx.repo },
    stateBranch: ctx.stateBranch,
    pollGapMs,
  });
  if (!quiet.quiet) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      `Activation readiness quiet-window failed: ${quiet.failClosedReason ?? "not_quiet"}`,
    );
  }

  const priorObservation =
    (quiet as { priorObservation?: QuietWindowObservation }).priorObservation ??
    null;
  const isolationEvidenceDigest = createHash("sha256")
    .update(
      JSON.stringify(
        {
          kind: "p-dev.activation-readiness-isolation.v1",
          epochId: input.epochId,
          activationCommitSha,
          observedAt: quiet.observedAt,
          priorObservation,
          tipSha: quiet.tipSha,
          activeRunIds: quiet.activeRuns.map((run) => run.id).sort((a, b) => a - b),
        },
        null,
        2,
      ),
      "utf8",
    )
    .digest("hex");

  const readiness = buildActivationReadinessRecord({
    epochId: input.epochId,
    activationCommitSha,
    activatedAt,
    cutoff,
    verifiedMode: "required",
    modeVerifiedAt: nowIso,
    isolationEvidenceDigest,
    verificationObservedAt: quiet.observedAt,
    contractVersion: input.contractVersion,
  });
  const readinessPath = activationReadinessRemotePath(input.epochId);
  const body = `${JSON.stringify(readiness, null, 2)}\n`;
  const write = await ctx.lifecycleStore.persistImmutableRecord({
    path: readinessPath,
    body,
    canonicalDigest: readiness.readinessDigest,
    commitMessage: `p-dev: activation readiness ${input.epochId}`,
  });

  const reloaded = await ctx.lifecycleStore.loadRecord(readinessPath);
  if (!reloaded) {
    throw new CursorProvenanceError(
      "cursor_provenance_state_unavailable",
      "Activation readiness record missing after write.",
    );
  }
  parseActivationReadinessRecord(reloaded);

  return {
    epochId: input.epochId,
    activationCommitSha,
    activatedAt,
    cutoff,
    readinessPath,
    readinessCommitSha:
      write.commitSha ?? ctx.lifecycleStore.commitShaForPath?.(readinessPath) ?? null,
    readinessDigestPrefix: readiness.readinessDigest.slice(0, 12),
    verificationObservedAt: quiet.observedAt,
    isolationEvidenceDigestPrefix: isolationEvidenceDigest.slice(0, 12),
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
    finalizationPolicy?: FinalizationPolicy;
    quietWindowObservations?: Array<{
      observedAt: string;
      activeRunIds: number[];
    }>;
    writePolicy?: "create_or_adopt" | "verify_existing_only"; // default create_or_adopt
    skipQuietWindowIfSealed?: boolean; // default true
  },
): Promise<
  | (FinalizeEpochSuccessResult & { sealed: true })
  | (FinalizeEpochIncompleteResult & { sealed: false })
> {
  const epochId = input.epochId;
  const writePolicy = input.writePolicy ?? "create_or_adopt";
  const configured =
    "configuredWritePolicy" in ctx.lifecycleStore
      ? ctx.lifecycleStore.configuredWritePolicy
      : null;
  if (configured && configured !== writePolicy) {
    throw new CursorProvenanceError(
      "cursor_provenance_config_invalid",
      `Lifecycle store policy mismatch (expected ${writePolicy}, got ${configured}).`,
    );
  }

  const stateTipBefore = await resolveStateTipSha(ctx);
  const eventSnapshotCommitSha = input.eventSnapshotCommitSha ?? stateTipBefore;
  const sealPath = coverageSealRemotePath(epochId);

  // Seal adoption path: always authoritative; always zero writes.
  const sealCommitSha = await ctx.service.resolveLatestCommitForPath(sealPath);
  if (sealCommitSha) {
    const inspection = await inspectAuthoritativeEpochCoverage(ctx as any, {
      epochId,
    });
    const stateTipAfter = await resolveStateTipSha(ctx);

    if (inspection.status === "sealed_complete") {
      const sealBody = await ctx.lifecycleStore.loadRecordAtCommit(sealPath, sealCommitSha);
      if (!sealBody) {
        throw new CursorProvenanceError(
          "cursor_provenance_coverage_integrity_error",
          "Seal missing at pinned commit.",
        );
      }
      const seal = JSON.parse(sealBody) as any;
      return {
        sealed: true,
        epochId,
        sealCommitSha,
        sealDigestPrefix: inspection.sealDigest ? digestPrefix(inspection.sealDigest) : digestPrefix(seal.sealDigest),
        snapshotCommitSha: inspection.snapshotCommitSha,
        snapshotDigestPrefix: digestPrefix(seal.coverageSnapshotDigest),
        proofCommitSha: inspection.historyProofCommitSha,
        proofDigestPrefix: digestPrefix(seal.activationHistoryProofDigest),
        activationCommitSha: inspection.activationCommitSha ?? seal.activationCommitSha,
        eventSnapshotCommitSha: inspection.eventSnapshotCommitSha ?? seal.eventSnapshotCommitSha,
        adoptedProof: true,
        adoptedSnapshot: true,
        adoptedSeal: true,
        writeAttemptCount: ctx.lifecycleStore.writeAttemptCount,
        writeCount: 0,
        wouldWriteKinds: [],
        stateTipBefore,
        stateTipAfter,
        postSealFullyEnumerated: inspection.postSealFullyEnumerated,
        postSealInvalidatingCount: inspection.postSealInvalidatingCount,
      };
    }

    return {
      sealed: false,
      epochId,
      gapCommitSha: null,
      gapDigestPrefix: "unknown",
      incompleteReasons: inspection.incompleteReasons,
      activationCommitSha: inspection.activationCommitSha ?? "unknown",
      eventSnapshotCommitSha: inspection.eventSnapshotCommitSha ?? eventSnapshotCommitSha,
      proofCommitSha: inspection.historyProofCommitSha,
      snapshotCommitSha: inspection.snapshotCommitSha,
      adoptedProof: true,
      adoptedSnapshot: true,
      adoptedSeal: true,
      writeAttemptCount: ctx.lifecycleStore.writeAttemptCount,
      writeCount: 0,
      wouldWriteKinds: [],
      stateTipBefore,
      stateTipAfter,
      postSealFullyEnumerated: inspection.postSealFullyEnumerated,
      postSealInvalidatingCount: inspection.postSealInvalidatingCount,
    };
  }

  // verify_existing_only: never attempt writes; return structured wouldWriteKinds.
  if (writePolicy === "verify_existing_only") {
    const wouldWriteKinds: FinalizeWouldWriteKind[] = [];
    const proofPath = activationHistoryProofRemotePath(epochId);
    const snapshotPath = coverageSnapshotRemotePath(epochId);

    if (!(await ctx.lifecycleStore.loadRecord(proofPath))) {
      wouldWriteKinds.push("history_proof");
    }
    if (!(await ctx.lifecycleStore.loadRecord(snapshotPath))) {
      wouldWriteKinds.push("snapshot");
    }
    wouldWriteKinds.push("seal");

    const provisional = await ctx.service.inspectProvisionalCoverage({
      epochId,
      eventSnapshotCommitSha,
    });
    const stateTipAfter = await resolveStateTipSha(ctx);
    return {
      sealed: false,
      epochId,
      gapCommitSha: null,
      gapDigestPrefix: "unknown",
      incompleteReasons: provisional.incompleteReasons.map((r) => String(r)),
      activationCommitSha: provisional.activationCommitSha ?? "unknown",
      eventSnapshotCommitSha,
      proofCommitSha: provisional.historyProofCommitSha,
      snapshotCommitSha: null,
      adoptedProof: false,
      adoptedSnapshot: false,
      adoptedSeal: false,
      writeAttemptCount: ctx.lifecycleStore.writeAttemptCount,
      writeCount: 0,
      wouldWriteKinds,
      stateTipBefore,
      stateTipAfter,
      postSealFullyEnumerated: false,
      postSealInvalidatingCount: 0,
    };
  }

  let writeCount = 0;

  const activationPath = activationRecordRemotePath(epochId);
  const activationCommitSha = await ctx.service.resolveLatestCommitForPath(activationPath);
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
  const policy = input.finalizationPolicy ?? DEFAULT_FINALIZATION_POLICY;
  const policyDigest =
    activationRecord.payload.finalizationPolicy?.digest ?? finalizePolicyDigest(policy);

  const activationSource: RetrievedActivationSource = {
    stateRepository: ctx.stateRepository,
    stateBranch: ctx.stateBranch,
    activationRecordPath: activationPath,
    immutableCommitSha: activationCommitSha,
  };

  // Claim relationship matching verifier derivation (equal|descendant).
  const claimedRelationship = claimActivationHistoryRelationship(
    activationCommitSha,
    eventSnapshotCommitSha,
  );

  const records = await ctx.service.enumerateEvents(eventSnapshotCommitSha);
  const hasNonEmptyEvidence = records.length > 0;
  if (hasNonEmptyEvidence && claimedRelationship === "equal") {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_integrity_error",
      "Non-empty coverage requires strict descendant history proof (not equal tip).",
    );
  }

  const proofPath = activationHistoryProofRemotePath(epochId);
  let adoptedProof = false;
  let proofCommitSha = (await ctx.service.resolveLatestCommitForPath(proofPath)) ?? null;
  let proofDigest: string | null = null;
  let verifiedProof: any = null;

  if (proofCommitSha) {
    const proofBody = await ctx.lifecycleStore.loadRecordAtCommit(proofPath, proofCommitSha);
    if (!proofBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "History proof missing at pinned commit.",
      );
    }
    const proofRecord = parseActivationHistoryProofRecord(proofBody);
    proofDigest = activationHistoryProofRecordDigest(proofRecord);
    const graph = await loadGitHubCommitGraph({
      client: ctx.client,
      owner: ctx.owner,
      repo: ctx.repo,
      branch: ctx.stateBranch,
      anchorShas: [activationCommitSha, eventSnapshotCommitSha],
    });
    const verified = verifyActivationHistoryProof({
      record: proofRecord,
      commitGraph: graph,
      expectedStateRepository: ctx.stateRepository,
      expectedStateBranch: ctx.stateBranch,
    });
    if (!("__brand" in verified)) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        `History proof verification failed: ${verified.reason}`,
      );
    }
    verifiedProof = verified;
    adoptedProof = true;
  } else {
    const proofWrite = await ctx.service.writeHistoryProof({
      epochId,
      activationCommitSha,
      eventSnapshotCommitSha,
      claimedRelationship,
    });
    if (!proofWrite.idempotent) writeCount += 1;
    proofCommitSha = proofWrite.commitSha ?? (await ctx.service.resolveLatestCommitForPath(proofPath));
    if (!proofCommitSha) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "History proof commit SHA could not be resolved.",
      );
    }
    proofDigest = activationHistoryProofRecordDigest(proofWrite.record);
    const graph = await loadGitHubCommitGraph({
      client: ctx.client,
      owner: ctx.owner,
      repo: ctx.repo,
      branch: ctx.stateBranch,
      anchorShas: [activationCommitSha, eventSnapshotCommitSha],
    });
    const verified = verifyActivationHistoryProof({
      record: proofWrite.record,
      commitGraph: graph,
      expectedStateRepository: ctx.stateRepository,
      expectedStateBranch: ctx.stateBranch,
    });
    if (!("__brand" in verified)) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        `History proof verification failed: ${verified.reason}`,
      );
    }
    verifiedProof = verified;
  }

  const snapshotPath = coverageSnapshotRemotePath(epochId);
  let adoptedSnapshot = false;
  let snapshotCommitSha =
    (await ctx.service.resolveLatestCommitForPath(snapshotPath)) ?? null;
  let envelope: ReturnType<typeof parsePersistedCoverageSnapshotEnvelope>;

  const recordsForSnapshot = await ctx.service.enumerateEvents(eventSnapshotCommitSha);
  const snapshot = buildCoverageSnapshot({
    interval: activationRecord.payload.interval,
    records: recordsForSnapshot,
    eventSnapshotSource: {
      stateRepository: ctx.stateRepository,
      stateBranch: ctx.stateBranch,
      immutableCommitSha: eventSnapshotCommitSha,
    },
    activationRecord,
    activationSource,
    activationHistoryProof: verifiedProof,
  });

  if (snapshotCommitSha) {
    const snapshotBody = await ctx.lifecycleStore.loadRecordAtCommit(snapshotPath, snapshotCommitSha);
    if (!snapshotBody) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Coverage snapshot missing at pinned commit.",
      );
    }
    envelope = parsePersistedCoverageSnapshotEnvelope(snapshotBody);
    if (envelope.snapshot.coverageDigest !== snapshot.coverageDigest) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Persisted coverage snapshot digest does not match recomputed digest.",
      );
    }
    adoptedSnapshot = true;
  } else {
    const snapshotWrite = await ctx.service.writeCoverageSnapshot({
      epochId,
      activationCommitSha,
      eventSnapshotCommitSha,
      activationHistoryProofCommitSha: proofCommitSha!,
      activationHistoryProofDigest: proofDigest!,
      snapshot,
      finalizationPolicyDigest: policyDigest,
    });
    if (!snapshotWrite.idempotent) writeCount += 1;
    snapshotCommitSha =
      snapshotWrite.commitSha ?? (await ctx.service.resolveLatestCommitForPath(snapshotWrite.path));
    const reloaded = await ctx.lifecycleStore.loadRecord(snapshotWrite.path);
    if (!reloaded) {
      throw new CursorProvenanceError(
        "cursor_provenance_coverage_integrity_error",
        "Coverage snapshot missing after write.",
      );
    }
    envelope = parsePersistedCoverageSnapshotEnvelope(reloaded);
  }

  if (envelope.snapshot.status !== "complete") {
    const evidenceDigest = createHash("sha256")
      .update(`p-dev.coverage-gap.v1|${epochId}|${eventSnapshotCommitSha}`, "utf8")
      .digest("hex");
    const gap = await ctx.service.reportGap({
      epochId,
      intervalAttempted: activationRecord.payload.interval,
      incompleteReasons: envelope.snapshot.incompleteReasons,
      evidenceDigest,
    });
    if (!gap.idempotent) writeCount += 1;
    const stateTipAfter = await resolveStateTipSha(ctx);
    return {
      sealed: false,
      epochId,
      gapCommitSha: gap.commitSha,
      gapDigestPrefix: digestPrefix(gap.gap.gapDigest),
      incompleteReasons: envelope.snapshot.incompleteReasons,
      activationCommitSha,
      eventSnapshotCommitSha,
      proofCommitSha,
      snapshotCommitSha,
      adoptedProof,
      adoptedSnapshot,
      adoptedSeal: false,
      writeAttemptCount: ctx.lifecycleStore.writeAttemptCount,
      writeCount,
      wouldWriteKinds: [],
      stateTipBefore,
      stateTipAfter,
      postSealFullyEnumerated: false,
      postSealInvalidatingCount: 0,
    };
  }

  // Creating a seal requires quiet-window evidence (adoption path already returned).
  const policyQuietCount = policy.quietPollCount;
  if (
    !input.quietWindowObservations ||
    input.quietWindowObservations.length < policyQuietCount
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_coverage_incomplete",
      `Quiet-window evidence requires at least ${policyQuietCount} observations.`,
    );
  }

  const quietDigest = quietWindowEvidenceDigest({
    observations: input.quietWindowObservations,
    policyDigest,
  });
  const finalDigest =
    input.finalizationEvidenceDigest ??
    operatorFinalizeEvidenceDigest({
      epochId,
      operatorToolSourceSha: input.operatorToolSourceSha,
      eventSnapshotCommitSha,
      finalizationPolicyDigest: policyDigest,
      quietWindowEvidenceDigest: quietDigest,
    });

  const sealWrite = await ctx.service.sealCoverage({
    epochId,
    operatorToolSourceSha: input.operatorToolSourceSha,
    finalizationEvidenceDigest: finalDigest,
    finalizationPolicyDigest: policyDigest,
    coverageSnapshotCommitSha: snapshotCommitSha ?? undefined,
  });
  if (!sealWrite.idempotent) writeCount += 1;

  const stateTipAfter = await resolveStateTipSha(ctx);
  return {
    sealed: true,
    epochId,
    sealCommitSha: sealWrite.commitSha,
    sealDigestPrefix: digestPrefix(sealWrite.seal.sealDigest),
    snapshotCommitSha,
    snapshotDigestPrefix: digestPrefix(envelope.envelopeDigest),
    proofCommitSha,
    proofDigestPrefix: digestPrefix(proofDigest!),
    activationCommitSha,
    eventSnapshotCommitSha,
    adoptedProof,
    adoptedSnapshot,
    adoptedSeal: false,
    writeAttemptCount: ctx.lifecycleStore.writeAttemptCount,
    writeCount,
    wouldWriteKinds: [],
    stateTipBefore,
    stateTipAfter,
    postSealFullyEnumerated: false,
    postSealInvalidatingCount: 0,
  };
}

async function resolveStateTipSha(ctx: OperatorCoverageContext): Promise<string> {
  const ref = await ctx.client.getGitRef(ctx.owner, ctx.repo, ctx.stateBranch);
  return ref.object.sha;
}

export { ACTIVATION_HISTORY_PROOF_KIND };

export type FinalizeWouldWriteKind = "history_proof" | "snapshot" | "seal";

export interface FinalizeEpochSuccessResult {
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
  adoptedProof: boolean;
  adoptedSnapshot: boolean;
  adoptedSeal: boolean;
  writeAttemptCount: number;
  writeCount: number;
  wouldWriteKinds: FinalizeWouldWriteKind[];
  stateTipBefore: string;
  stateTipAfter: string;
  postSealFullyEnumerated: boolean;
  postSealInvalidatingCount: number;
}

export interface FinalizeEpochIncompleteResult {
  sealed: false;
  epochId: string;
  gapCommitSha: string | null;
  gapDigestPrefix: string;
  incompleteReasons: string[];
  activationCommitSha: string;
  eventSnapshotCommitSha: string;
  proofCommitSha: string | null;
  snapshotCommitSha: string | null;
  adoptedProof: boolean;
  adoptedSnapshot: boolean;
  adoptedSeal: boolean;
  writeAttemptCount: number;
  writeCount: number;
  wouldWriteKinds: FinalizeWouldWriteKind[];
  stateTipBefore: string;
  stateTipAfter: string;
  postSealFullyEnumerated: boolean;
  postSealInvalidatingCount: number;
}
