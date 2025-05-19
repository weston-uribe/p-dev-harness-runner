import { randomUUID } from "node:crypto";
import type { HarnessManagedRepoMarker } from "./harness-managed-repo-marker.js";
import {
  buildCompleteUpgradeCommitsOnBranch,
  buildRunnerUpgradeBranchNameForManifest,
  compareRunnerUpgradeSnapshots,
  findExistingUpgradePullRequest,
  loadRunnerUpgradePackagedSnapshot,
  readManagedMarkerAtRef,
  resolveRunnerUpgradeTargetContext,
  verifyCompleteCandidateHead,
  type RunnerUpgradeTargetContext,
} from "./runner-upgrade-materialization.js";
import type { RunnerUpgradeGitHubProvider } from "./runner-upgrade-provider.js";
import {
  buildRunnerUpgradePrMarker,
} from "./runner-upgrade-types.js";

export type PrepareRunnerUpgradePullRequestErrorCode =
  | "embedded_snapshot_unavailable"
  | "repository_not_accessible"
  | "repository_identity_mismatch"
  | "main_baseline_mismatch"
  | "main_drift"
  | "blocked_non_managed"
  | "blocked_operator_conflicts"
  | "blocked_unexpected_remote"
  | "conflicting_branch"
  | "conflicting_pr"
  | "already_current";

export class PrepareRunnerUpgradePullRequestError extends Error {
  readonly code: PrepareRunnerUpgradePullRequestErrorCode;

  constructor(code: PrepareRunnerUpgradePullRequestErrorCode, message: string) {
    super(message);
    this.name = "PrepareRunnerUpgradePullRequestError";
    this.code = code;
  }
}

export interface PrepareRunnerUpgradePullRequestOptions {
  repoSlug: string;
  repositoryId: number;
  requiredBaseSha: string;
  operationId?: string;
}

export interface PrepareRunnerUpgradeCompleteIdentities {
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  snapshotCommitSha: string;
  markerCommitSha: string;
  packagedSourceCommit: string;
  packageVersion: string;
}

export interface PrepareRunnerUpgradePullRequestResult {
  baseSha: string;
  branchName: string;
  prNumber: number;
  prUrl: string;
  candidateHeadSha: string;
  packagedSourceCommit: string;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  snapshotCommitSha: string;
  markerCommitSha: string;
  completeIdentities: PrepareRunnerUpgradeCompleteIdentities;
}

function throwPrepareError(
  code: PrepareRunnerUpgradePullRequestErrorCode,
  message: string,
): never {
  throw new PrepareRunnerUpgradePullRequestError(code, message);
}

async function assertMainUnchanged(
  provider: RunnerUpgradeGitHubProvider,
  context: RunnerUpgradeTargetContext,
  requiredBaseSha: string,
): Promise<void> {
  const currentHead = await provider.getRepositoryDefaultBranchHead(
    context.owner,
    context.repo,
    context.defaultBranch,
  );
  if (currentHead !== requiredBaseSha) {
    throwPrepareError(
      "main_drift",
      `Default branch moved during prepare (expected ${requiredBaseSha}, found ${currentHead}).`,
    );
  }
}

function buildCompleteIdentities(input: {
  context: RunnerUpgradeTargetContext;
  snapshotCommitSha: string;
  markerCommitSha: string;
}): PrepareRunnerUpgradeCompleteIdentities {
  const manifest = input.context.packagedSnapshot.manifest;
  return {
    snapshotContentId: manifest.snapshotContentId,
    snapshotSha256: manifest.snapshotSha256,
    snapshotGitTreeSha1: manifest.gitRootTreeSha1,
    snapshotCommitSha: input.snapshotCommitSha,
    markerCommitSha: input.markerCommitSha,
    packagedSourceCommit: manifest.sourceCommit,
    packageVersion: manifest.packageVersion,
  };
}

function buildPrepareResult(input: {
  context: RunnerUpgradeTargetContext;
  branchName: string;
  prNumber: number;
  prUrl: string;
  snapshotCommitSha: string;
  markerCommitSha: string;
}): PrepareRunnerUpgradePullRequestResult {
  const completeIdentities = buildCompleteIdentities({
    context: input.context,
    snapshotCommitSha: input.snapshotCommitSha,
    markerCommitSha: input.markerCommitSha,
  });
  return {
    baseSha: input.context.defaultBranchHead,
    branchName: input.branchName,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    candidateHeadSha: input.markerCommitSha,
    packagedSourceCommit: completeIdentities.packagedSourceCommit,
    snapshotContentId: completeIdentities.snapshotContentId,
    snapshotSha256: completeIdentities.snapshotSha256,
    snapshotGitTreeSha1: completeIdentities.snapshotGitTreeSha1,
    snapshotCommitSha: completeIdentities.snapshotCommitSha,
    markerCommitSha: completeIdentities.markerCommitSha,
    completeIdentities,
  };
}

async function tryAdoptExistingCandidate(input: {
  provider: RunnerUpgradeGitHubProvider;
  context: RunnerUpgradeTargetContext;
  branchName: string;
  targetSnapshotContentId: string;
  operationId: string;
  requiredBaseSha: string;
}): Promise<PrepareRunnerUpgradePullRequestResult | null> {
  let branchHeadSha: string | null = null;
  try {
    const branchRef = await input.provider.getGitRef(
      input.context.owner,
      input.context.repo,
      input.branchName,
    );
    branchHeadSha = branchRef.object.sha;
  } catch {
    branchHeadSha = null;
  }

  const existingPr = await findExistingUpgradePullRequest(input.provider, {
    owner: input.context.owner,
    repo: input.context.repo,
    repositoryId: input.context.repositoryId,
    snapshotContentId: input.targetSnapshotContentId,
    defaultBranch: input.context.defaultBranch,
    branchName: input.branchName,
  });

  if (!branchHeadSha && !existingPr) {
    return null;
  }

  if (branchHeadSha && existingPr && branchHeadSha !== existingPr.headSha) {
    throwPrepareError(
      "conflicting_pr",
      `Open PR #${existingPr.number} head (${existingPr.headSha}) does not match branch ${input.branchName} (${branchHeadSha}).`,
    );
  }

  const candidateHeadSha = branchHeadSha ?? existingPr?.headSha;
  if (!candidateHeadSha) {
    return null;
  }

  const markerAtHead = await readManagedMarkerAtRef(input.provider, {
    owner: input.context.owner,
    repo: input.context.repo,
    ref: candidateHeadSha,
  });
  if (!markerAtHead.ok) {
    if (branchHeadSha) {
      throwPrepareError(
        "conflicting_branch",
        `Candidate branch ${input.branchName} exists but marker is invalid: ${markerAtHead.reason}`,
      );
    }
    return null;
  }

  const snapshotCommitSha =
    markerAtHead.marker.createdFromPackageSnapshot?.snapshotCommitSha;
  if (!snapshotCommitSha || snapshotCommitSha === "pending") {
    throwPrepareError(
      "conflicting_branch",
      `Candidate branch ${input.branchName} has a provisional marker.`,
    );
  }

  const verified = await verifyCompleteCandidateHead(input.provider, {
    context: input.context,
    headSha: candidateHeadSha,
    expectedSnapshotCommitSha: snapshotCommitSha,
  });
  if (!verified.ok) {
    throwPrepareError("conflicting_branch", verified.reason);
  }

  if (
    markerAtHead.marker.createdFromPackageSnapshot?.snapshotContentId !==
    input.targetSnapshotContentId
  ) {
    throwPrepareError(
      "conflicting_branch",
      `Candidate branch targets snapshot ${markerAtHead.marker.createdFromPackageSnapshot?.snapshotContentId}, expected ${input.targetSnapshotContentId}.`,
    );
  }

  if (!existingPr) {
    throwPrepareError(
      "conflicting_branch",
      `Candidate branch ${input.branchName} exists without a matching open upgrade PR.`,
    );
  }

  await assertMainUnchanged(
    input.provider,
    input.context,
    input.requiredBaseSha,
  );

  return buildPrepareResult({
    context: input.context,
    branchName: input.branchName,
    prNumber: existingPr.number,
    prUrl: existingPr.htmlUrl,
    snapshotCommitSha,
    markerCommitSha: candidateHeadSha,
  });
}

async function createOrAdoptPullRequest(input: {
  provider: RunnerUpgradeGitHubProvider;
  context: RunnerUpgradeTargetContext;
  branchName: string;
  targetSnapshotContentId: string;
  candidateHeadSha: string;
}): Promise<{ number: number; htmlUrl: string }> {
  const existingPr = await findExistingUpgradePullRequest(input.provider, {
    owner: input.context.owner,
    repo: input.context.repo,
    repositoryId: input.context.repositoryId,
    snapshotContentId: input.targetSnapshotContentId,
    defaultBranch: input.context.defaultBranch,
    branchName: input.branchName,
  });

  if (existingPr) {
    if (existingPr.headSha !== input.candidateHeadSha) {
      throwPrepareError(
        "conflicting_pr",
        `Open PR #${existingPr.number} head (${existingPr.headSha}) does not match candidate head (${input.candidateHeadSha}).`,
      );
    }
    return { number: existingPr.number, htmlUrl: existingPr.htmlUrl };
  }

  const branchPr = await findExistingUpgradePullRequest(input.provider, {
    owner: input.context.owner,
    repo: input.context.repo,
    repositoryId: input.context.repositoryId,
    snapshotContentId: input.targetSnapshotContentId,
    defaultBranch: input.context.defaultBranch,
    branchName: input.branchName,
  });
  if (branchPr && branchPr.headSha !== input.candidateHeadSha) {
    throwPrepareError(
      "conflicting_pr",
      `Branch ${input.branchName} is tied to PR #${branchPr.number} with mismatched head.`,
    );
  }

  const byBranchOnly = await input.provider.listPullRequests(
    input.context.owner,
    input.context.repo,
    { state: "open", base: input.context.defaultBranch },
  );
  const conflictingBranchPr = byBranchOnly.find(
    (pull) =>
      pull.headRef === input.branchName &&
      pull.headSha !== input.candidateHeadSha,
  );
  if (conflictingBranchPr) {
    throwPrepareError(
      "conflicting_pr",
      `Open PR #${conflictingBranchPr.number} on ${input.branchName} has unexpected head ${conflictingBranchPr.headSha}.`,
    );
  }

  const created = await input.provider.createPullRequest({
    owner: input.context.owner,
    repo: input.context.repo,
    title: `Update p-dev runner to ${input.context.packagedSnapshot.packageVersion}`,
    head: input.branchName,
    base: input.context.defaultBranch,
    body: [
      buildRunnerUpgradePrMarker(
        input.context.repositoryId,
        input.targetSnapshotContentId,
      ),
      "",
      `Updates the managed p-dev runner workspace to package ${input.context.packagedSnapshot.packageVersion}.`,
      "",
      "Prepared for eval pipeline verification; merge is intentionally deferred.",
    ].join("\n"),
  });
  return { number: created.number, htmlUrl: created.htmlUrl };
}

/**
 * Materialize a managed runner upgrade onto a candidate branch and open (or
 * adopt) exactly one deterministic PR. Stops before merge, cloud sync,
 * workflow dispatch, or canary.
 */
export async function prepareRunnerUpgradePullRequest(
  cwd: string | undefined,
  provider: RunnerUpgradeGitHubProvider,
  options: PrepareRunnerUpgradePullRequestOptions,
): Promise<PrepareRunnerUpgradePullRequestResult> {
  void cwd;

  const packagedSnapshot = await loadRunnerUpgradePackagedSnapshot(import.meta.url);
  if (!packagedSnapshot) {
    throwPrepareError(
      "embedded_snapshot_unavailable",
      "Embedded workspace snapshot is unavailable.",
    );
  }

  const resolved = await resolveRunnerUpgradeTargetContext(provider, {
    repoSlug: options.repoSlug,
    repositoryId: options.repositoryId,
    requiredBaseSha: options.requiredBaseSha,
    packagedSnapshot,
  });
  if (!resolved.ok) {
    throwPrepareError(
      resolved.code as PrepareRunnerUpgradePullRequestErrorCode,
      resolved.message,
    );
  }
  const context = resolved.context;
  const targetSnapshotContentId = packagedSnapshot.manifest.snapshotContentId;
  const operationId = options.operationId ?? randomUUID();
  const branchName = buildRunnerUpgradeBranchNameForManifest(
    packagedSnapshot.manifest,
  );

  if (
    context.marker.createdFromPackageSnapshot?.snapshotContentId ===
    targetSnapshotContentId
  ) {
    throwPrepareError(
      "already_current",
      "Remote runner already matches the packaged snapshot.",
    );
  }

  const adopted = await tryAdoptExistingCandidate({
    provider,
    context,
    branchName,
    targetSnapshotContentId,
    operationId,
    requiredBaseSha: options.requiredBaseSha,
  });
  if (adopted) {
    return adopted;
  }

  const compare = await compareRunnerUpgradeSnapshots(provider, context);
  if (!compare.ok) {
    throwPrepareError(compare.status, compare.message);
  }

  await assertMainUnchanged(provider, context, options.requiredBaseSha);

  let branchHeadSha: string | null = null;
  try {
    const branchRef = await provider.getGitRef(
      context.owner,
      context.repo,
      branchName,
    );
    branchHeadSha = branchRef.object.sha;
  } catch {
    branchHeadSha = null;
  }
  if (branchHeadSha) {
    throwPrepareError(
      "conflicting_branch",
      `Candidate branch ${branchName} exists without a matching complete upgrade head.`,
    );
  }

  const materialized = await buildCompleteUpgradeCommitsOnBranch(provider, context, {
    operationId,
    branchName,
    replacePaths: compare.replacePaths,
    deletePaths: compare.deletePaths,
    requiredBaseSha: options.requiredBaseSha,
  });

  await assertMainUnchanged(provider, context, options.requiredBaseSha);

  const pr = await createOrAdoptPullRequest({
    provider,
    context,
    branchName,
    targetSnapshotContentId,
    candidateHeadSha: materialized.candidateHeadSha,
  });

  return buildPrepareResult({
    context,
    branchName,
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
    snapshotCommitSha: materialized.snapshotCommitSha,
    markerCommitSha: materialized.markerCommitSha,
  });
}

export type {
  HarnessManagedRepoMarker,
};
