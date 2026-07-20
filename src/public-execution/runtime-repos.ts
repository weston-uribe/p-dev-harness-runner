export const P_DEV_WORKFLOW_STATE_REPOSITORY_ENV =
  "P_DEV_WORKFLOW_STATE_REPOSITORY";
export const P_DEV_WORKFLOW_STATE_BRANCH_ENV = "P_DEV_WORKFLOW_STATE_BRANCH";
export const P_DEV_JOB_REQUEST_REPOSITORY_ENV = "P_DEV_JOB_REQUEST_REPOSITORY";
export const P_DEV_STATE_GITHUB_TOKEN_ENV = "P_DEV_STATE_GITHUB_TOKEN";
export const GITHUB_DISPATCH_REPOSITORY_ENV = "GITHUB_DISPATCH_REPOSITORY";

export const DEFAULT_WORKFLOW_STATE_BRANCH = "p-dev-runtime-state";

export function parseRepoSlug(
  slug: string | undefined,
): { owner: string; repo: string } | null {
  const trimmed = slug?.trim();
  if (!trimmed) {
    return null;
  }

  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo || repo.includes("/")) {
    return null;
  }

  return { owner, repo };
}

export function resolveWorkflowStateRepository(
  env: Record<string, string | undefined> = process.env,
): { owner: string; repo: string } | null {
  return parseRepoSlug(env[P_DEV_WORKFLOW_STATE_REPOSITORY_ENV]);
}

export function resolveJobRequestRepository(
  env: Record<string, string | undefined> = process.env,
): { owner: string; repo: string } | null {
  return (
    parseRepoSlug(env[P_DEV_JOB_REQUEST_REPOSITORY_ENV]) ??
    resolveWorkflowStateRepository(env)
  );
}

export function resolveWorkflowStateBranch(
  env: Record<string, string | undefined> = process.env,
): string {
  const branch = env[P_DEV_WORKFLOW_STATE_BRANCH_ENV]?.trim();
  return branch || DEFAULT_WORKFLOW_STATE_BRANCH;
}

export function resolveStateGithubToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env[P_DEV_STATE_GITHUB_TOKEN_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  const harnessToken = env.HARNESS_GITHUB_TOKEN?.trim();
  if (harnessToken) {
    return harnessToken;
  }

  const githubToken = env.GITHUB_TOKEN?.trim();
  return githubToken || null;
}

/**
 * Resolve the credential used for repository_dispatch.
 * Policy: GITHUB_DISPATCH_TOKEN ?? HARNESS_GITHUB_TOKEN (never GITHUB_TOKEN).
 */
export function resolveDispatchGithubToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dispatchToken = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (dispatchToken) {
    return dispatchToken;
  }
  const harnessToken = env.HARNESS_GITHUB_TOKEN?.trim();
  return harnessToken || null;
}

export function resolveExecutionRepository(
  env: Record<string, string | undefined> = process.env,
): { owner: string; repo: string } | null {
  return parseRepoSlug(env[GITHUB_DISPATCH_REPOSITORY_ENV]);
}
