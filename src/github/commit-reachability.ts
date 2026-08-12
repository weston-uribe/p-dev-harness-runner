import type { GitHubClient } from "./client.js";
import { parseGitHubRepoUrl } from "./base-branch.js";
import { parsePrUrl } from "./pr-url.js";

export interface CommitReachabilityResult {
  reachable: boolean;
  status: string;
  aheadBy: number;
  behindBy: number;
  productionHeadSha: string;
}

/** True when `ancestorSha` is an ancestor of `descendantSha` (or equal). */
export async function isCommitAncestorOf(
  client: GitHubClient,
  owner: string,
  repo: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  if (ancestorSha.toLowerCase() === descendantSha.toLowerCase()) {
    return true;
  }
  const compare = await client.compareCommits(
    owner,
    repo,
    ancestorSha,
    descendantSha,
  );
  return compare.behind_by === 0 && compare.status !== "diverged";
}

export async function isCommitReachableFromBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  commitSha: string,
  productionBranch: string,
): Promise<CommitReachabilityResult> {
  const branchRef = await client.getBranchRef(owner, repo, productionBranch);
  const productionHeadSha = branchRef.object.sha;
  if (commitSha.toLowerCase() === productionHeadSha.toLowerCase()) {
    return {
      reachable: true,
      status: "identical",
      aheadBy: 0,
      behindBy: 0,
      productionHeadSha,
    };
  }
  const compare = await client.compareCommits(
    owner,
    repo,
    commitSha,
    productionHeadSha,
  );
  const reachable =
    compare.behind_by === 0 && compare.status !== "diverged";

  return {
    reachable,
    status: compare.status,
    aheadBy: compare.ahead_by,
    behindBy: compare.behind_by,
    productionHeadSha,
  };
}

export interface PromotionProofSuccess {
  proof: true;
  method: "merge_commit_sha" | "pr_merge_commit";
  mergeCommitSha: string;
  productionHeadSha: string;
}

export interface PromotionProofFailure {
  proof: false;
  reason: string;
  diagnosticIssueKeyCommits?: string[];
}

export type PromotionProofResult = PromotionProofSuccess | PromotionProofFailure;

export interface ResolvePromotionProofInput {
  client: GitHubClient;
  targetRepo: string;
  productionBranch: string;
  mergeCommitSha?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  issueKey?: string;
  baseBranch?: string;
}

export async function resolvePromotionProof(
  input: ResolvePromotionProofInput,
): Promise<PromotionProofResult> {
  const parsed = parseGitHubRepoUrl(input.targetRepo);
  if (!parsed) {
    return { proof: false, reason: "invalid_target_repo" };
  }

  const { owner, repo } = parsed;
  let diagnosticIssueKeyCommits: string[] | undefined;

  if (input.mergeCommitSha) {
    const reachability = await isCommitReachableFromBranch(
      input.client,
      owner,
      repo,
      input.mergeCommitSha,
      input.productionBranch,
    );
    if (reachability.reachable) {
      return {
        proof: true,
        method: "merge_commit_sha",
        mergeCommitSha: input.mergeCommitSha,
        productionHeadSha: reachability.productionHeadSha,
      };
    }
  }

  let prMergeCommitSha: string | null = null;
  if (input.prUrl) {
    const parsedPr = parsePrUrl(input.prUrl);
    if (parsedPr) {
      const pull = await input.client.getPullRequest(
        parsedPr.owner,
        parsedPr.repo,
        parsedPr.pullNumber,
      );
      prMergeCommitSha = pull.merge_commit_sha;
    }
  } else if (input.prNumber) {
    const pull = await input.client.getPullRequest(owner, repo, input.prNumber);
    prMergeCommitSha = pull.merge_commit_sha;
  }

  if (prMergeCommitSha) {
    const reachability = await isCommitReachableFromBranch(
      input.client,
      owner,
      repo,
      prMergeCommitSha,
      input.productionBranch,
    );
    if (reachability.reachable) {
      return {
        proof: true,
        method: "pr_merge_commit",
        mergeCommitSha: prMergeCommitSha,
        productionHeadSha: reachability.productionHeadSha,
      };
    }
  }

  if (input.issueKey) {
    diagnosticIssueKeyCommits = await findIssueKeyCommitsOnProduction(
      input.client,
      owner,
      repo,
      input.productionBranch,
      input.issueKey,
      input.baseBranch,
    );
  }

  // Issue-key commits on production without merge-SHA ancestry indicate an
  // unsupported squash/rebase production promotion (merge/FF contract only).
  if (diagnosticIssueKeyCommits && diagnosticIssueKeyCommits.length > 0) {
    return {
      proof: false,
      reason: "promotion_method_unsupported",
      diagnosticIssueKeyCommits,
    };
  }

  return {
    proof: false,
    reason: "production_not_promoted",
    diagnosticIssueKeyCommits,
  };
}

export async function findIssueKeyCommitsOnProduction(
  client: GitHubClient,
  owner: string,
  repo: string,
  productionBranch: string,
  issueKey: string,
  baseBranch?: string,
): Promise<string[]> {
  const branchRef = await client.getBranchRef(owner, repo, productionBranch);
  const productionHeadSha = branchRef.object.sha;

  let compareBase = productionHeadSha;
  if (baseBranch) {
    try {
      const baseRef = await client.getBranchRef(owner, repo, baseBranch);
      compareBase = baseRef.object.sha;
    } catch {
      compareBase = productionHeadSha;
    }
  }

  const compare = await client.compareCommits(
    owner,
    repo,
    compareBase,
    productionHeadSha,
  );

  const pattern = new RegExp(
    issueKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );

  return compare.commits
    .filter((commit) => pattern.test(commit.commit.message))
    .map((commit) => commit.sha);
}
