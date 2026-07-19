import type { RunResult } from "@cursor/sdk";
import { normalizeRepoUrl, repoUrlsEquivalent } from "../resolver/normalize-repo.js";
import { ImplementationError } from "../runner/errors.js";

export interface CapturedGitResult {
  repoUrl: string;
  branch: string;
  prUrl: string;
}

function normalizePrRepoUrl(prUrl: string): string | null {
  const match = prUrl.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+\/?$/,
  );
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

function formatRepoMismatch(actualRaw: string, expectedRaw: string): string {
  const actualNormalized = normalizeRepoUrl(actualRaw);
  const expectedNormalized = normalizeRepoUrl(expectedRaw);
  return (
    `Cursor run modified repo "${actualRaw}" (normalized: ${actualNormalized}); ` +
    `expected "${expectedRaw}" (normalized: ${expectedNormalized})`
  );
}

export function extractTargetRepoGitResult(
  git: RunResult["git"],
  targetRepo: string,
): CapturedGitResult {
  const normalizedTarget = normalizeRepoUrl(targetRepo);
  const branches = git?.branches ?? [];
  const wrongRepo = branches.find(
    (branch) => !repoUrlsEquivalent(branch.repoUrl, normalizedTarget),
  );
  if (wrongRepo) {
    throw new ImplementationError(
      "wrong_target_repo",
      formatRepoMismatch(wrongRepo.repoUrl, targetRepo),
    );
  }

  const targetBranch = branches.find((branch) =>
    repoUrlsEquivalent(branch.repoUrl, normalizedTarget),
  );
  if (!targetBranch) {
    throw new ImplementationError(
      "pr_not_created",
      `Cursor run did not report git metadata for ${normalizedTarget}`,
    );
  }

  if (!targetBranch.branch && !targetBranch.prUrl) {
    throw new ImplementationError(
      "pr_not_created",
      `Cursor run did not report a branch or PR for ${normalizedTarget}`,
    );
  }

  if (targetBranch.branch && !targetBranch.prUrl) {
    throw new ImplementationError(
      "branch_without_pr",
      `Cursor run created branch ${targetBranch.branch} without a PR`,
    );
  }

  if (!targetBranch.branch || !targetBranch.prUrl) {
    throw new ImplementationError(
      "pr_not_created",
      `Cursor run did not report a complete branch and PR for ${normalizedTarget}`,
    );
  }

  const prRepoUrl = normalizePrRepoUrl(targetBranch.prUrl);
  if (prRepoUrl !== normalizedTarget) {
    throw new ImplementationError(
      "wrong_pr_target",
      `Cursor run opened PR ${targetBranch.prUrl} (repo normalized: ${prRepoUrl ?? "unknown"}); expected repo ${normalizedTarget}`,
    );
  }

  return {
    repoUrl: normalizedTarget,
    branch: targetBranch.branch,
    prUrl: targetBranch.prUrl,
  };
}
