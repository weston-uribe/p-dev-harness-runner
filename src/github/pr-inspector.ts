import { repoUrlsEquivalent } from "../resolver/normalize-repo.js";
import type { GitHubClient, GitHubCheckRun, GitHubCommitStatus } from "./client.js";
import { GitHubApiError } from "./client.js";
import type { ParsedPrUrl } from "./pr-url.js";

export interface PrChangedFile {
  path: string;
  status: string;
}

export interface PrCheckInfo {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface PrInspectionResult {
  title: string;
  url: string;
  branch: string;
  /** Live PR branch head commit; use for check lookup and guarded merge. */
  headSha: string;
  baseSha: string;
  baseBranch: string;
  state: string;
  merged: boolean;
  isDraft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  rebaseable: boolean | null;
  /** Merge-result metadata only (synthetic test-merge on open PRs, merge commit when merged). */
  mergeCommitSha: string | null;
  mergedAt: string | null;
  repoUrl: string;
  changedFiles: PrChangedFile[];
  checks: PrCheckInfo[];
  checkSummary: string;
  comments: { author: string; body: string; createdAt: string }[];
  rawChecks: GitHubCheckRun[] | null;
}

function summarizeChecks(checks: PrCheckInfo[]): string {
  if (checks.length === 0) {
    return "No GitHub check runs reported for the PR head commit.";
  }

  const passed = checks.filter((c) => c.conclusion === "success").length;
  const failed = checks.filter(
    (c) => c.conclusion === "failure" || c.conclusion === "cancelled",
  ).length;
  const pending = checks.filter(
    (c) => c.status !== "completed" || c.conclusion === null,
  ).length;

  const lines = [
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    `- Pending/unknown: ${pending}`,
  ];

  const notableFailures = checks.filter((c) => c.conclusion === "failure");
  for (const check of notableFailures.slice(0, 5)) {
    lines.push(`- Failed check: ${check.name}${check.detailsUrl ? ` (${check.detailsUrl})` : ""}`);
  }

  return lines.join("\n");
}

function mapCommitStatusToCheck(status: GitHubCommitStatus): PrCheckInfo {
  const state = status.state.toLowerCase();
  let conclusion: string | null = null;
  let checkStatus = "completed";

  if (state === "success") {
    conclusion = "success";
  } else if (state === "pending") {
    conclusion = null;
    checkStatus = "queued";
  } else if (state === "failure" || state === "error") {
    conclusion = "failure";
  } else {
    conclusion = state;
  }

  return {
    name: status.context,
    status: checkStatus,
    conclusion,
    detailsUrl: status.target_url,
  };
}

function checksFromCombinedStatus(
  combined: { state: string; statuses: GitHubCommitStatus[] },
): PrCheckInfo[] {
  if (combined.statuses.length > 0) {
    return combined.statuses.map(mapCommitStatusToCheck);
  }

  const state = combined.state.toLowerCase();
  if (state === "pending") {
    return [
      {
        name: "combined-status",
        status: "queued",
        conclusion: null,
        detailsUrl: null,
      },
    ];
  }

  return [
    {
      name: "combined-status",
      status: "completed",
      conclusion: state === "success" ? "success" : "failure",
      detailsUrl: null,
    },
  ];
}

export async function inspectPullRequest(
  client: GitHubClient,
  parsed: ParsedPrUrl,
  expectedTargetRepo: string,
): Promise<PrInspectionResult> {
  const result = await inspectPullRequestRaw(client, parsed, expectedTargetRepo);
  if (result.state !== "open" || result.merged) {
    throw new Error(`pr_closed: PR ${result.url} is not open`);
  }
  return result;
}

export async function inspectPullRequestForMerge(
  client: GitHubClient,
  parsed: ParsedPrUrl,
  expectedTargetRepo: string,
): Promise<PrInspectionResult> {
  const result = await inspectPullRequestRaw(client, parsed, expectedTargetRepo);
  if (result.merged) {
    return result;
  }
  if (result.state !== "open") {
    throw new Error(`pr_closed: PR ${result.url} is closed but not merged`);
  }
  return result;
}

export async function inspectPullRequestPostMerge(
  client: GitHubClient,
  parsed: ParsedPrUrl,
  expectedTargetRepo: string,
): Promise<PrInspectionResult> {
  const result = await inspectPullRequestRaw(client, parsed, expectedTargetRepo);
  if (!result.merged) {
    throw new Error(`pr_not_merged: PR ${result.url} is not merged`);
  }
  return result;
}

export async function pollPullRequestMergeability(
  client: GitHubClient,
  parsed: ParsedPrUrl,
  expectedTargetRepo: string,
  options: {
    timeoutSeconds: number;
    intervalSeconds: number;
  },
): Promise<PrInspectionResult> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let latest = await inspectPullRequestForMerge(client, parsed, expectedTargetRepo);

  while (Date.now() < deadline) {
    const state = latest.mergeableState?.toLowerCase() ?? null;
    if (latest.mergeable !== null && state !== "unknown") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1000));
    latest = await inspectPullRequestForMerge(client, parsed, expectedTargetRepo);
  }

  return latest;
}

async function inspectPullRequestRaw(
  client: GitHubClient,
  parsed: ParsedPrUrl,
  expectedTargetRepo: string,
): Promise<PrInspectionResult> {
  if (!repoUrlsEquivalent(parsed.repoUrl, expectedTargetRepo)) {
    throw new Error(
      `wrong_target_repo: PR repo ${parsed.repoUrl} does not match expected ${expectedTargetRepo}`,
    );
  }

  let pull;
  try {
    pull = await client.getPullRequest(parsed.owner, parsed.repo, parsed.pullNumber);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 401) {
      throw error;
    }
    throw error;
  }

  let files: { filename: string; status: string }[] = [];
  if (!pull.merged) {
    files = await client.getPullRequestFiles(
      parsed.owner,
      parsed.repo,
      parsed.pullNumber,
    );
  }

  // merge_commit_sha is merge-result metadata (synthetic test-merge on open PRs).
  // Never use it for check/status lookup or as headSha identity.
  const checkRefSha = pull.head.sha;

  let rawChecks: GitHubCheckRun[] | null = null;
  let checks: PrCheckInfo[] = [];
  try {
    const checkPayload = await client.getCheckRunsForRef(
      parsed.owner,
      parsed.repo,
      checkRefSha,
    );
    rawChecks = checkPayload.check_runs ?? [];
    checks = rawChecks.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url,
    }));
  } catch {
    rawChecks = null;
    checks = [];
  }

  if (checks.length === 0) {
    try {
      const combined = await client.getCombinedStatusForRef(
        parsed.owner,
        parsed.repo,
        checkRefSha,
      );
      checks = checksFromCombinedStatus(combined);
    } catch {
      // Keep empty checks if combined status is unavailable.
    }
  }

  const commentsRaw = await client.getIssueComments(
    parsed.owner,
    parsed.repo,
    parsed.pullNumber,
  );

  const comments = commentsRaw.map((comment) => ({
    author: comment.user?.login ?? "unknown",
    body: comment.body,
    createdAt: comment.created_at,
  }));

  const changedFiles = files.map((file) => ({
    path: file.filename,
    status: file.status,
  }));

  return {
    title: pull.title,
    url: pull.html_url,
    branch: pull.head.ref,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    baseBranch: pull.base.ref,
    state: pull.state,
    merged: pull.merged,
    isDraft: pull.draft === true,
    mergeable: pull.mergeable ?? null,
    mergeableState: pull.mergeable_state ?? null,
    rebaseable: pull.rebaseable ?? null,
    mergeCommitSha: pull.merge_commit_sha,
    mergedAt: pull.merged_at,
    repoUrl: parsed.repoUrl,
    changedFiles,
    checks,
    checkSummary: summarizeChecks(checks),
    comments,
    rawChecks,
  };
}

export function classifyGitHubError(error: unknown): "github_auth_failure" | "github_api_failure" {
  if (error instanceof GitHubApiError && error.status === 401) {
    return "github_auth_failure";
  }
  return "github_api_failure";
}
