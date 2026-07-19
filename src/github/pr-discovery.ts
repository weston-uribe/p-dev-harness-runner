import type { GitHubClient } from "./client.js";
import { parseGitHubRepoUrl } from "./base-branch.js";

export interface DiscoveredPullRequest {
  prUrl: string;
  prNumber: number;
  branch: string;
  headSha: string;
  baseBranch: string;
}

export function buildIssueKeyBranchPattern(issueKey: string): RegExp {
  const normalized = issueKey.trim().toLowerCase();
  return new RegExp(`(^|[/-])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/-]|$)`, "i");
}

export function headBranchMatchesIssueKey(headRef: string, issueKey: string): boolean {
  return buildIssueKeyBranchPattern(issueKey).test(headRef);
}

export async function findImplementationPullRequest(
  client: GitHubClient,
  targetRepo: string,
  baseBranch: string,
  issueKey: string,
): Promise<DiscoveredPullRequest | null> {
  const parsed = parseGitHubRepoUrl(targetRepo);
  if (!parsed) {
    return null;
  }

  const pulls = await client.listPullRequests(parsed.owner, parsed.repo, {
    state: "open",
    base: baseBranch,
    sort: "created",
    direction: "desc",
  });

  const matching = pulls.filter((pull) =>
    headBranchMatchesIssueKey(pull.head.ref, issueKey),
  );

  if (matching.length === 0) {
    return null;
  }

  const selected = matching[0];
  return {
    prUrl: selected.html_url,
    prNumber: selected.number,
    branch: selected.head.ref,
    headSha: selected.head.sha,
    baseBranch: selected.base.ref,
  };
}
