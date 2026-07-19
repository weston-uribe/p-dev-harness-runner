import type { RunResult } from "@cursor/sdk";
import { parsePrUrl } from "../github/pr-url.js";
import { normalizeRepoUrl, repoUrlsEquivalent } from "../resolver/normalize-repo.js";
import { RevisionError } from "../runner/errors.js";
import type { CapturedGitResult } from "./git-result.js";

function formatRepoMismatch(actualRaw: string, expectedRaw: string): string {
  const actualNormalized = normalizeRepoUrl(actualRaw);
  const expectedNormalized = normalizeRepoUrl(expectedRaw);
  return (
    `Cursor run modified repo "${actualRaw}" (normalized: ${actualNormalized}); ` +
    `expected "${expectedRaw}" (normalized: ${expectedNormalized})`
  );
}

export function extractRevisionGitResult(
  git: RunResult["git"],
  targetRepo: string,
  expectedBranch: string,
  expectedPrUrl: string,
): CapturedGitResult {
  const normalizedTarget = normalizeRepoUrl(targetRepo);
  const expectedPr = parsePrUrl(expectedPrUrl);
  if (!expectedPr) {
    throw new RevisionError("revision_pr_mismatch", `Invalid expected PR URL: ${expectedPrUrl}`);
  }

  const branches = git?.branches ?? [];
  const wrongRepo = branches.find(
    (branch) => !repoUrlsEquivalent(branch.repoUrl, normalizedTarget),
  );
  if (wrongRepo) {
    throw new RevisionError(
      "wrong_target_repo",
      formatRepoMismatch(wrongRepo.repoUrl, targetRepo),
    );
  }

  const targetBranch = branches.find((branch) =>
    repoUrlsEquivalent(branch.repoUrl, normalizedTarget),
  );
  if (!targetBranch?.branch || !targetBranch.prUrl) {
    throw new RevisionError(
      "cursor_branch_attach_failure",
      `Cursor revision run did not report git metadata for ${normalizedTarget}`,
    );
  }

  const actualPr = parsePrUrl(targetBranch.prUrl);
  if (!actualPr) {
    throw new RevisionError(
      "revision_pr_mismatch",
      `Cursor revision run reported invalid PR URL: ${targetBranch.prUrl}`,
    );
  }

  if (
    actualPr.owner !== expectedPr.owner ||
    actualPr.repo !== expectedPr.repo ||
    actualPr.pullNumber !== expectedPr.pullNumber
  ) {
    throw new RevisionError(
      "revision_pr_mismatch",
      `Cursor revision run reported PR ${targetBranch.prUrl}; expected ${expectedPrUrl}`,
    );
  }

  if (targetBranch.branch !== expectedBranch) {
    throw new RevisionError(
      "revision_pr_mismatch",
      `Cursor revision run reported branch ${targetBranch.branch}; expected ${expectedBranch}`,
    );
  }

  return {
    repoUrl: normalizedTarget,
    branch: targetBranch.branch,
    prUrl: targetBranch.prUrl,
  };
}
