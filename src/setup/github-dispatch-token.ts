import { GitHubApiError, GitHubClient } from "../github/client.js";
import { resolveHarnessDispatchRepo } from "./harness-dispatch-repo.js";
import type { HarnessRepoProvisioningSummary } from "./harness-repo-provisioning.js";
import { inspectGitHubTokenMetadata } from "./service-verification.js";
import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";

export type GitHubDispatchTokenSource =
  | "saved-github-token"
  | "manual-required";

export interface GitHubDispatchTokenEligibility {
  eligible: boolean;
  source: GitHubDispatchTokenSource;
  repository?: string;
  message: string;
}

export async function assessGitHubDispatchTokenEligibility(input: {
  githubToken?: string;
  cwd?: string;
  harnessProvisioningSummary?: HarnessRepoProvisioningSummary;
  verifiedDispatchRepo?: string | null;
  requireVerifiedPackagedDispatchRepo?: boolean;
}): Promise<GitHubDispatchTokenEligibility> {
  const token = input.githubToken?.trim();
  if (!token) {
    return {
      eligible: false,
      source: "manual-required",
      message:
        "Add GITHUB_TOKEN in Step 1 with Contents write access to the harness dispatch repository.",
    };
  }

  const packagedRuntime =
    input.harnessProvisioningSummary?.runtimeMode === "packaged" ||
    isPackagedPDevRuntime();
  const verifiedDispatchRepo =
    input.verifiedDispatchRepo?.trim() ||
    (input.harnessProvisioningSummary?.verifiedSavedRepo
      ? input.harnessProvisioningSummary.harnessDispatchRepo?.trim()
      : undefined);

  if (
    packagedRuntime &&
    input.requireVerifiedPackagedDispatchRepo === true &&
    !verifiedDispatchRepo
  ) {
    return {
      eligible: false,
      source: "manual-required",
      message:
        "Complete Step 1 to connect a verified harness workspace before configuring the PDev automation bridge.",
    };
  }

  const dispatchRepo = await resolveHarnessDispatchRepo({
    cwd: input.cwd,
    verifiedProvisioningRepo: verifiedDispatchRepo,
  });
  if (!dispatchRepo.resolved || !dispatchRepo.repo) {
    return {
      eligible: false,
      source: "manual-required",
      message:
        dispatchRepo.detail ??
        "Could not resolve the harness dispatch repository. Set GITHUB_DISPATCH_REPOSITORY in Step 1.",
    };
  }

  const [owner, repo] = dispatchRepo.repo.split("/");
  if (!owner || !repo) {
    return {
      eligible: false,
      source: "manual-required",
      repository: dispatchRepo.repo,
      message: "Harness dispatch repository slug is invalid.",
    };
  }

  try {
    await inspectGitHubTokenMetadata(token);
    const client = new GitHubClient({ token });
    const repository = await client.getRepository(owner, repo);
    const canWriteContents =
      repository.permissions?.push === true ||
      repository.permissions?.admin === true ||
      repository.permissions?.maintain === true;

    if (!canWriteContents) {
      return {
        eligible: false,
        source: "manual-required",
        repository: dispatchRepo.repo,
        message: `Saved GITHUB_TOKEN cannot write repository contents for ${dispatchRepo.repo}. repository_dispatch requires Contents write access.`,
      };
    }

    return {
      eligible: true,
      source: "saved-github-token",
      repository: dispatchRepo.repo,
      message: `Saved GITHUB_TOKEN can dispatch to ${dispatchRepo.repo}.`,
    };
  } catch (error) {
    const message =
      error instanceof GitHubApiError
        ? `GitHub rejected dispatch token eligibility check (${error.status}).`
        : error instanceof Error
          ? error.message
          : "GitHub dispatch token eligibility check failed.";
    return {
      eligible: false,
      source: "manual-required",
      repository: dispatchRepo.repo,
      message,
    };
  }
}
