/**
 * Durable WorkflowStateStore backed by GitHub Contents API on p-dev-runtime-state.
 * Uses blob SHA as the remote compare-and-set token plus internal stateRevision.
 */

import {
  GitHubApiError,
  type GitHubClient,
} from "../../github/client.js";
import {
  WORKFLOW_STATE_RECORD_KIND,
  type WorkflowStateRecord,
} from "./types.js";
import type { WorkflowStateStore } from "./store.js";

export const WORKFLOW_RUNTIME_STATE_BRANCH = "p-dev-runtime-state";

export function workflowStateRemotePath(
  teamId: string,
  issueKey: string,
): string {
  const safeTeam = teamId.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  const safeIssue = issueKey.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return `.p-dev/workflow-state/${safeTeam}/${safeIssue}.json`;
}

export interface GithubWorkflowStateStoreOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  teamId: string;
  branch?: string;
  /** Optional hook for concurrency tests. */
  beforeWrite?: () => Promise<void>;
}

export class GithubWorkflowStateStore implements WorkflowStateStore {
  private readonly branch: string;
  private blobShaByIssue = new Map<string, string | null>();

  constructor(private readonly options: GithubWorkflowStateStoreOptions) {
    this.branch = options.branch ?? WORKFLOW_RUNTIME_STATE_BRANCH;
  }

  private pathFor(issueKey: string): string {
    return workflowStateRemotePath(this.options.teamId, issueKey);
  }

  async ensureBranch(): Promise<void> {
    const { client, owner, repo } = this.options;
    try {
      await client.getGitRef(owner, repo, this.branch);
      return;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
    }
    const repoInfo = await client.getRepository(owner, repo);
    const defaultBranch = repoInfo.default_branch?.trim() || "main";
    const defaultRef = await client.getGitRef(owner, repo, defaultBranch);
    try {
      await client.createGitRef(owner, repo, this.branch, defaultRef.object.sha);
    } catch (error) {
      // Race: another process created the branch.
      if (error instanceof GitHubApiError && error.status === 422) {
        await client.getGitRef(owner, repo, this.branch);
        return;
      }
      throw error;
    }
  }

  async load(issueKey: string): Promise<WorkflowStateRecord | null> {
    const { client, owner, repo } = this.options;
    const path = this.pathFor(issueKey);
    const content = await client.getRepositoryContent(
      owner,
      repo,
      path,
      this.branch,
    );
    if (!content) {
      this.blobShaByIssue.set(issueKey, null);
      return null;
    }
    this.blobShaByIssue.set(issueKey, content.sha);
    const raw = client.decodeRepositoryContent(content);
    const parsed = JSON.parse(raw) as WorkflowStateRecord;
    if (parsed.kind !== WORKFLOW_STATE_RECORD_KIND) {
      return null;
    }
    return parsed;
  }

  async compareAndSet(input: {
    issueKey: string;
    expectedRevision: number;
    next: WorkflowStateRecord;
  }): Promise<WorkflowStateRecord | null> {
    if (this.options.beforeWrite) {
      await this.options.beforeWrite();
    }
    await this.ensureBranch();
    const { client, owner, repo } = this.options;
    const path = this.pathFor(input.issueKey);

    const current = await this.load(input.issueKey);
    const currentRevision = current?.stateRevision ?? -1;
    if (!current) {
      if (input.expectedRevision !== 0) return null;
    } else if (currentRevision !== input.expectedRevision) {
      return null;
    }
    if (input.next.stateRevision !== input.expectedRevision + 1) {
      return null;
    }

    const expectedBlobSha = this.blobShaByIssue.get(input.issueKey) ?? null;
    const body = `${JSON.stringify(input.next, null, 2)}\n`;

    try {
      if (expectedBlobSha) {
        await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path,
          branch: this.branch,
          message: `workflow-state: ${input.issueKey} r${input.next.stateRevision}`,
          content: body,
          sha: expectedBlobSha,
        });
      } else {
        // Create — omit sha. Concurrent creates: only one wins.
        await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path,
          branch: this.branch,
          message: `workflow-state: ${input.issueKey} create`,
          content: body,
        });
      }
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 409 || error.status === 422)
      ) {
        // Stale blob SHA or create race — conflict.
        await this.load(input.issueKey);
        return null;
      }
      throw error;
    }

    // Refresh blob SHA cache after successful write.
    await this.load(input.issueKey);
    return structuredClone(input.next);
  }
}
