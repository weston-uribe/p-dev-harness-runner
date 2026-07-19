/**
 * Explicit workflow state store selection.
 * Managed GitHub Actions execution must use managed_github and never fall back to file.
 */

import path from "node:path";
import { GitHubClient } from "../../github/client.js";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../../public-execution/runtime-repos.js";
import {
  FileWorkflowStateStore,
  InMemoryWorkflowStateStore,
  type WorkflowStateStore,
} from "./store.js";
import { GithubWorkflowStateStore } from "./github-store.js";

export type WorkflowStateStoreMode = "managed_github" | "file" | "memory";

export const WORKFLOW_STATE_STORE_MODE_ENV = "P_DEV_WORKFLOW_STATE_STORE_MODE";

export class WorkflowStateStoreError extends Error {
  constructor(
    public readonly code:
      | "missing_store_mode"
      | "invalid_store_mode"
      | "managed_store_init_failed"
      | "managed_store_missing_credentials"
      | "managed_store_missing_dispatch_repo"
      | "managed_store_missing_state_repository"
      | "managed_store_missing_team",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowStateStoreError";
  }
}

export function resolveWorkflowStateStoreMode(
  env: Record<string, string | undefined> = process.env,
): WorkflowStateStoreMode {
  const raw = env[WORKFLOW_STATE_STORE_MODE_ENV]?.trim().toLowerCase();
  if (!raw) {
    // Local/dev default — never treat bare GITHUB_ACTIONS as managed write authority.
    return "file";
  }
  if (raw === "managed_github" || raw === "file" || raw === "memory") {
    return raw;
  }
  throw new WorkflowStateStoreError(
    "invalid_store_mode",
    `Invalid ${WORKFLOW_STATE_STORE_MODE_ENV}=${raw}. Expected managed_github|file|memory.`,
  );
}

export interface CreateWorkflowStateStoreInput {
  mode?: WorkflowStateStoreMode;
  /** Required for file mode. */
  logDirectory?: string;
  /** Required for managed_github. */
  teamId?: string;
  /** Optional override for managed_github state repository owner. */
  stateOwner?: string;
  /** Optional override for managed_github state repository name. */
  stateRepo?: string;
  /** Optional override for managed_github state branch. */
  stateBranch?: string;
  githubToken?: string;
  env?: Record<string, string | undefined>;
  /** Test injection. */
  githubClient?: GitHubClient;
}

/**
 * Create the authoritative workflow state store for this process.
 * managed_github fails closed — never silently falls back to FileWorkflowStateStore.
 */
export async function createWorkflowStateStore(
  input: CreateWorkflowStateStoreInput = {},
): Promise<WorkflowStateStore> {
  const env = input.env ?? process.env;
  const mode = input.mode ?? resolveWorkflowStateStoreMode(env);

  if (mode === "memory") {
    return new InMemoryWorkflowStateStore();
  }

  if (mode === "file") {
    const root = input.logDirectory ?? env.HARNESS_LOG_DIRECTORY ?? "runs";
    return new FileWorkflowStateStore(path.resolve(root));
  }

  // managed_github — fail closed
  const teamId = input.teamId?.trim();
  if (!teamId) {
    throw new WorkflowStateStoreError(
      "managed_store_missing_team",
      "Managed workflow state requires a Linear teamId. Refusing to fall back to local file state.",
    );
  }

  const token =
    input.githubToken?.trim() || resolveStateGithubToken(env);
  if (!token) {
    throw new WorkflowStateStoreError(
      "managed_store_missing_credentials",
      "Managed workflow state requires a GitHub token. Refusing to fall back to local file state.",
    );
  }

  const fromParts =
    input.stateOwner && input.stateRepo
      ? { owner: input.stateOwner, repo: input.stateRepo }
      : null;
  const stateRepository = fromParts ?? resolveWorkflowStateRepository(env);
  if (!stateRepository) {
    throw new WorkflowStateStoreError(
      "managed_store_missing_state_repository",
      "Managed workflow state requires P_DEV_WORKFLOW_STATE_REPOSITORY. Refusing to fall back to local file state.",
    );
  }

  const branch = input.stateBranch ?? resolveWorkflowStateBranch(env);
  const client = input.githubClient ?? new GitHubClient({ token });
  const store = new GithubWorkflowStateStore({
    client,
    owner: stateRepository.owner,
    repo: stateRepository.repo,
    teamId,
    branch,
  });

  try {
    await store.ensureBranch();
  } catch (error) {
    throw new WorkflowStateStoreError(
      "managed_store_init_failed",
      error instanceof Error
        ? `Managed workflow state branch could not be initialized: ${error.message}`
        : "Managed workflow state branch could not be initialized.",
    );
  }

  return store;
}
