import { appendFileSync } from "node:fs";
import { GitHubClient } from "../../github/client.js";
import {
  maskValueForGithubActions,
  shouldKeepIssueKeyOutOfGithubEnv,
  writePrivateRuntimeContext,
} from "../../public-execution/private-runtime-context.js";
import {
  resolveJobRequestRepository,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
} from "../../public-execution/runtime-repos.js";
import { GithubJobRequestStore } from "./store.js";

export class JobRequestRuntimeError extends Error {
  constructor(
    public readonly code:
      | "missing_state_token"
      | "missing_job_request_repository",
    message: string,
  ) {
    super(message);
    this.name = "JobRequestRuntimeError";
  }
}

export async function createGithubJobRequestStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
  githubClient?: GitHubClient,
): Promise<GithubJobRequestStore> {
  const token = resolveStateGithubToken(env);
  if (!token) {
    throw new JobRequestRuntimeError(
      "missing_state_token",
      "Managed job requests require a GitHub state token.",
    );
  }

  const repo = resolveJobRequestRepository(env);
  if (!repo) {
    throw new JobRequestRuntimeError(
      "missing_job_request_repository",
      "Managed job requests require P_DEV_JOB_REQUEST_REPOSITORY.",
    );
  }

  const client = githubClient ?? new GitHubClient({ token });
  const store = new GithubJobRequestStore({
    client,
    owner: repo.owner,
    repo: repo.repo,
    branch: resolveWorkflowStateBranch(env),
  });
  await store.ensureBranch();
  return store;
}

/**
 * Persist the claimed issue key for later steps in this job.
 * In public-runner mode, never write HARNESS_ISSUE_KEY to GITHUB_ENV — Actions
 * dumps that file into every subsequent step's env log.
 */
export function writeHarnessIssueKeyToGithubEnv(issueKey: string): void {
  const trimmed = issueKey.trim();
  if (!trimmed) {
    return;
  }

  writePrivateRuntimeContext({ issueKey: trimmed });
  maskValueForGithubActions(trimmed);

  if (shouldKeepIssueKeyOutOfGithubEnv()) {
    return;
  }

  const githubEnvPath = process.env.GITHUB_ENV?.trim();
  if (!githubEnvPath) {
    return;
  }

  appendFileSync(githubEnvPath, `HARNESS_ISSUE_KEY=${trimmed}\n`, "utf8");
}

/**
 * Persist authoritative Linear delivery id from a claimed job request.
 */
export function writeLinearDeliveryIdToGithubEnv(linearDeliveryId: string): void {
  const trimmed = linearDeliveryId.trim();
  if (!trimmed) {
    return;
  }

  maskValueForGithubActions(trimmed);

  const githubEnvPath = process.env.GITHUB_ENV?.trim();
  if (!githubEnvPath) {
    return;
  }

  appendFileSync(githubEnvPath, `LINEAR_DELIVERY_ID=${trimmed}\n`, "utf8");
}
