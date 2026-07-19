import { createHash } from "node:crypto";
import { GitHubApiError, type GitHubClient } from "../github/client.js";
import {
  buildTargetWorkflowBranchName,
  buildTargetWorkflowPrTitle,
  compareTargetWorkflowContent,
} from "./target-workflow-setup.js";

export interface InstallBranchRecoveryProofInput {
  configuredTargetRepoSlug: string;
  observedTargetRepoSlug: string;
  configuredRepoConfigId: string;
  reservedBranchName: string;
  observedBranchName: string;
  configuredProductionBranch: string;
  observedProductionBranch: string;
  configuredWorkflowPath: string;
  pullRequestOwner: string;
  pullRequestRepo: string;
  /** 0 allowed when recovering a closed/empty PR that deleted the branch. */
  openPullRequestsOnBranch: number;
  allowZeroOpenPullRequests?: boolean;
}

export type InstallBranchRecoveryProofResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateInstallBranchRecoveryProof(
  input: InstallBranchRecoveryProofInput,
): InstallBranchRecoveryProofResult {
  const expectedBranch = buildTargetWorkflowBranchName(
    input.configuredRepoConfigId,
  );

  if (input.configuredTargetRepoSlug !== input.observedTargetRepoSlug) {
    return {
      ok: false,
      reason: "Install branch recovery target repository mismatch.",
    };
  }
  if (input.reservedBranchName !== expectedBranch) {
    return {
      ok: false,
      reason: "Install branch recovery reserved branch name mismatch.",
    };
  }
  if (input.observedBranchName !== expectedBranch) {
    return {
      ok: false,
      reason: "Install branch recovery PR head branch mismatch.",
    };
  }
  if (input.observedProductionBranch !== input.configuredProductionBranch) {
    return {
      ok: false,
      reason: "Install branch recovery PR base branch mismatch.",
    };
  }
  if (
    `${input.pullRequestOwner}/${input.pullRequestRepo}` !==
    input.configuredTargetRepoSlug
  ) {
    return {
      ok: false,
      reason: "Install branch recovery PR repository mismatch.",
    };
  }
  const maxOpen = 1;
  const minOpen = input.allowZeroOpenPullRequests ? 0 : 1;
  if (
    input.openPullRequestsOnBranch < minOpen ||
    input.openPullRequestsOnBranch > maxOpen
  ) {
    return {
      ok: false,
      reason:
        "Install branch recovery requires at most one open PR on the reserved branch.",
    };
  }

  return { ok: true };
}

export interface InstallBranchStalenessInput {
  changedFiles: Array<{ path: string }>;
  workflowPath: string;
  mergeableState: string | null;
  compareStatus?: string | null;
  headWorkflowMatchesIntended: boolean;
  filesValidationPassed: boolean;
}

/**
 * Determines whether a harness-owned install branch is stale enough to warrant
 * force-reset recovery. An empty PR changed-files list alone is not sufficient.
 */
export function isStaleHarnessInstallBranch(
  input: InstallBranchStalenessInput,
): boolean {
  if (!input.headWorkflowMatchesIntended) {
    return true;
  }

  if (input.filesValidationPassed) {
    return false;
  }

  const mergeState = input.mergeableState?.toLowerCase() ?? "";
  const compareState = input.compareStatus?.toLowerCase() ?? "";
  const behindOrDiverged =
    mergeState === "behind" ||
    compareState === "behind" ||
    compareState === "diverged";

  if (behindOrDiverged) {
    return true;
  }

  if (
    input.changedFiles.length === 1 &&
    input.changedFiles[0]?.path !== input.workflowPath
  ) {
    return true;
  }

  if (input.changedFiles.length > 1) {
    return true;
  }

  return false;
}

export function buildWorkflowInstallPrMarker(repoConfigId: string): string {
  return `<!-- p-dev-workflow-install:${repoConfigId} -->`;
}

export function workflowInstallPrBodyContainsMarker(
  body: string | null | undefined,
  repoConfigId: string,
): boolean {
  if (!body) {
    return false;
  }
  return body.includes(buildWorkflowInstallPrMarker(repoConfigId));
}

export function hashWorkflowContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface RecoverHarnessInstallBranchInput {
  client: GitHubClient;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  workflowPath: string;
  workflowContent: string;
  commitMessage?: string;
  /** Observed reserved-branch head before commit construction; null if missing. */
  expectedReservedBranchHeadSha?: string | null;
}

export type RecoverHarnessInstallBranchResult =
  | {
      recovered: true;
      headSha: string;
      productionSha: string;
      commitSha: string;
    }
  | {
      recovered: false;
      noop?: boolean;
      needsReconciliation?: boolean;
      reason: string;
      observedHeadSha?: string;
    };

export async function isInstallBranchAlreadyClean(input: {
  client: GitHubClient;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  workflowPath: string;
  intendedWorkflowContent: string;
}): Promise<boolean> {
  const [owner, repo] = input.targetRepoSlug.split("/");
  let branchRef: { object: { sha: string } };
  try {
    branchRef = await input.client.getBranchRef(
      owner,
      repo,
      input.branchName,
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return false;
    }
    throw error;
  }

  const productionRef = await input.client.getBranchRef(
    owner,
    repo,
    input.productionBranch,
  );
  if (branchRef.object.sha === productionRef.object.sha) {
    return false;
  }

  const compare = await input.client.compareCommits(
    owner,
    repo,
    input.productionBranch,
    input.branchName,
  );
  if (compare.status !== "ahead" || compare.ahead_by !== 1) {
    return false;
  }

  const files = compare.files ?? [];
  if (files.length !== 1 || files[0]?.filename !== input.workflowPath) {
    return false;
  }

  const headContent = await input.client.getRepositoryContent(
    owner,
    repo,
    input.workflowPath,
    input.branchName,
  );
  if (!headContent) {
    return false;
  }
  const decoded = input.client.decodeRepositoryContent(headContent);
  return (
    compareTargetWorkflowContent(decoded, input.intendedWorkflowContent) ===
    "present"
  );
}

async function readReservedBranchHeadSha(
  client: GitHubClient,
  owner: string,
  repo: string,
  branchName: string,
): Promise<string | null> {
  try {
    const ref = await client.getBranchRef(owner, repo, branchName);
    return ref.object.sha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function buildVerifiedWorkflowCommit(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  productionSha: string;
  workflowPath: string;
  workflowContent: string;
  commitMessage: string;
}): Promise<{ commitSha: string; treeSha: string }> {
  const parentCommit = await input.client.getGitCommit(
    input.owner,
    input.repo,
    input.productionSha,
  );
  const blob = await input.client.createGitBlob({
    owner: input.owner,
    repo: input.repo,
    content: Buffer.from(input.workflowContent, "utf8"),
  });
  const tree = await input.client.createGitTree({
    owner: input.owner,
    repo: input.repo,
    baseTree: parentCommit.tree.sha,
    tree: [
      {
        path: input.workflowPath,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      },
    ],
  });
  const commit = await input.client.createGitCommit({
    owner: input.owner,
    repo: input.repo,
    message: input.commitMessage,
    tree: tree.sha,
    parents: [input.productionSha],
  });

  if (commit.parents[0]?.sha !== input.productionSha) {
    throw new Error(
      "Install branch recovery commit parent does not match production head.",
    );
  }
  if (commit.tree.sha !== tree.sha) {
    throw new Error(
      "Install branch recovery commit tree does not match constructed tree.",
    );
  }

  const compare = await input.client.compareCommits(
    input.owner,
    input.repo,
    input.productionSha,
    commit.sha,
  );
  const files = compare.files ?? [];
  if (files.length !== 1 || files[0]?.filename !== input.workflowPath) {
    throw new Error(
      "Install branch recovery commit must change exactly the workflow path.",
    );
  }

  return { commitSha: commit.sha, treeSha: tree.sha };
}

async function verifyBranchPostconditions(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  productionBranch: string;
  productionSha: string;
  branchName: string;
  expectedHeadSha: string;
  workflowPath: string;
  workflowContent: string;
}): Promise<void> {
  const branchRef = await input.client.getBranchRef(
    input.owner,
    input.repo,
    input.branchName,
  );
  if (branchRef.object.sha !== input.expectedHeadSha) {
    throw new Error(
      `Install branch head mismatch after update (expected ${input.expectedHeadSha}, got ${branchRef.object.sha}).`,
    );
  }
  if (branchRef.object.sha === input.productionSha) {
    throw new Error(
      "Install branch head must differ from production after recovery.",
    );
  }

  const commit = await input.client.getGitCommit(
    input.owner,
    input.repo,
    branchRef.object.sha,
  );
  if (commit.parents[0]?.sha !== input.productionSha) {
    throw new Error(
      "Install branch commit parent must be current production head.",
    );
  }

  const compare = await input.client.compareCommits(
    input.owner,
    input.repo,
    input.productionBranch,
    input.branchName,
  );
  const files = compare.files ?? [];
  if (files.length !== 1 || files[0]?.filename !== input.workflowPath) {
    throw new Error(
      "Install branch must differ from production by exactly the workflow path.",
    );
  }

  const headContent = await input.client.getRepositoryContent(
    input.owner,
    input.repo,
    input.workflowPath,
    input.branchName,
  );
  if (!headContent) {
    throw new Error("Install branch is missing the intended workflow file.");
  }
  const decoded = input.client.decodeRepositoryContent(headContent);
  if (
    compareTargetWorkflowContent(decoded, input.workflowContent) !== "present"
  ) {
    throw new Error(
      "Install branch workflow content does not match the intended workflow.",
    );
  }
}

/**
 * Commit-first reserved-branch recovery.
 *
 * Never points the reserved branch at production. Builds a verified commit on
 * current production, race-checks the reserved branch head, then force-updates
 * only that reserved branch to the verified commit.
 */
export async function recoverHarnessInstallBranch(
  input: RecoverHarnessInstallBranchInput,
): Promise<RecoverHarnessInstallBranchResult> {
  const [owner, repo] = input.targetRepoSlug.split("/");
  if (!input.branchName.startsWith("harness/setup-production-sync-")) {
    return {
      recovered: false,
      reason: "Force update refused: branch is not a reserved install branch.",
    };
  }

  const productionRef = await input.client.getBranchRef(
    owner,
    repo,
    input.productionBranch,
  );
  const productionSha = productionRef.object.sha;

  const observedHeadBefore =
    input.expectedReservedBranchHeadSha !== undefined
      ? input.expectedReservedBranchHeadSha
      : await readReservedBranchHeadSha(
          input.client,
          owner,
          repo,
          input.branchName,
        );

  const commitMessage =
    input.commitMessage ?? buildTargetWorkflowPrTitle();

  let commitSha: string;
  try {
    const built = await buildVerifiedWorkflowCommit({
      client: input.client,
      owner,
      repo,
      productionSha,
      workflowPath: input.workflowPath,
      workflowContent: input.workflowContent,
      commitMessage,
    });
    commitSha = built.commitSha;
  } catch (error) {
    return {
      recovered: false,
      reason:
        error instanceof Error
          ? error.message
          : "Failed to build verified workflow install commit.",
    };
  }

  // Race guard: re-read immediately before mutation.
  const observedHeadAtMutation = await readReservedBranchHeadSha(
    input.client,
    owner,
    repo,
    input.branchName,
  );
  if (observedHeadAtMutation !== observedHeadBefore) {
    return {
      recovered: false,
      needsReconciliation: true,
      reason:
        "Reserved install branch head changed during recovery; reconciling instead of overwriting.",
      observedHeadSha: observedHeadAtMutation ?? undefined,
    };
  }

  if (observedHeadAtMutation === null) {
    await input.client.createGitRef(owner, repo, input.branchName, commitSha);
  } else {
    await input.client.updateGitRef({
      owner,
      repo,
      ref: input.branchName,
      sha: commitSha,
      force: true,
    });
  }

  try {
    await verifyBranchPostconditions({
      client: input.client,
      owner,
      repo,
      productionBranch: input.productionBranch,
      productionSha,
      branchName: input.branchName,
      expectedHeadSha: commitSha,
      workflowPath: input.workflowPath,
      workflowContent: input.workflowContent,
    });
  } catch (error) {
    return {
      recovered: false,
      reason:
        error instanceof Error
          ? error.message
          : "Install branch postcondition verification failed.",
    };
  }

  return {
    recovered: true,
    headSha: commitSha,
    productionSha,
    commitSha,
  };
}

export async function countOpenPullRequestsOnBranch(
  client: GitHubClient,
  input: {
    targetRepoSlug: string;
    productionBranch: string;
    branchName: string;
  },
): Promise<number> {
  const [owner, repo] = input.targetRepoSlug.split("/");
  const pulls = await client.listPullRequests(owner, repo, {
    state: "open",
    base: input.productionBranch,
    head: `${owner}:${input.branchName}`,
  });
  return pulls.length;
}

export async function findInstallPullRequestByMarker(input: {
  client: GitHubClient;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  repoConfigId: string;
  state?: "open" | "closed" | "all";
}): Promise<{
  number: number;
  html_url: string;
  headSha: string;
  state: string;
  body?: string | null;
} | null> {
  const [owner, repo] = input.targetRepoSlug.split("/");
  const pulls = await input.client.listPullRequests(owner, repo, {
    state: input.state ?? "open",
    base: input.productionBranch,
    head: `${owner}:${input.branchName}`,
    sort: "updated",
    direction: "desc",
  });
  const marker = buildWorkflowInstallPrMarker(input.repoConfigId);
  for (const pull of pulls) {
    const body = pull.body ?? "";
    if (!body.includes(marker)) {
      continue;
    }
    if (pull.head.ref !== input.branchName) {
      continue;
    }
    if (pull.base.ref !== input.productionBranch) {
      continue;
    }
    return {
      number: pull.number,
      html_url: pull.html_url,
      headSha: pull.head.sha,
      state: pull.state,
      body: pull.body,
    };
  }
  return null;
}

export async function ensureOpenInstallPullRequest(input: {
  client: GitHubClient;
  targetRepoSlug: string;
  productionBranch: string;
  branchName: string;
  repoConfigId: string;
  prTitle: string;
  prBody: string;
  verifiedHeadSha: string;
  harnessDispatchRepo: string;
}): Promise<{
  prNumber: number;
  prUrl: string;
  created: boolean;
  supersededPrNumber?: number;
}> {
  const [owner, repo] = input.targetRepoSlug.split("/");

  const openByHead = await input.client.listPullRequests(owner, repo, {
    state: "open",
    base: input.productionBranch,
    head: `${owner}:${input.branchName}`,
  });
  const openMatch = openByHead.find(
    (pull) =>
      pull.head.ref === input.branchName &&
      pull.base.ref === input.productionBranch &&
      pull.head.sha === input.verifiedHeadSha &&
      workflowInstallPrBodyContainsMarker(pull.body, input.repoConfigId),
  );
  if (openMatch) {
    return {
      prNumber: openMatch.number,
      prUrl: openMatch.html_url,
      created: false,
    };
  }

  // Any open PR on the reserved branch with matching head — reuse if body has marker or add via recreate path.
  const openAny = openByHead.find(
    (pull) =>
      pull.head.ref === input.branchName &&
      pull.base.ref === input.productionBranch &&
      pull.head.sha === input.verifiedHeadSha,
  );
  if (openAny) {
    return {
      prNumber: openAny.number,
      prUrl: openAny.html_url,
      created: false,
    };
  }

  const closedMatch = await findInstallPullRequestByMarker({
    client: input.client,
    targetRepoSlug: input.targetRepoSlug,
    productionBranch: input.productionBranch,
    branchName: input.branchName,
    repoConfigId: input.repoConfigId,
    state: "closed",
  });

  const bodyWithMarker = input.prBody.includes(
    buildWorkflowInstallPrMarker(input.repoConfigId),
  )
    ? input.prBody
    : `${input.prBody}\n\n${buildWorkflowInstallPrMarker(input.repoConfigId)}\n`;

  const created = await input.client.createPullRequest({
    owner,
    repo,
    title: input.prTitle,
    head: input.branchName,
    base: input.productionBranch,
    body: bodyWithMarker,
  });

  return {
    prNumber: created.number,
    prUrl: created.html_url,
    created: true,
    supersededPrNumber: closedMatch?.number,
  };
}
