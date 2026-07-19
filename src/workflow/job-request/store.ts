/**
 * Durable job-request envelope store backed by GitHub Contents API.
 * Uses blob SHA as the remote compare-and-set token plus internal revision.
 */

import {
  GitHubApiError,
  type GitHubClient,
} from "../../github/client.js";
import { jobRequestRemotePath } from "./paths.js";
import {
  JOB_REQUEST_KIND,
  type JobRequestRecord,
} from "./types.js";
import { DEFAULT_WORKFLOW_STATE_BRANCH } from "../../public-execution/runtime-repos.js";

export class JobRequestStoreError extends Error {
  constructor(
    public readonly code: "already_exists" | "conflict" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "JobRequestStoreError";
  }
}

export interface GithubJobRequestStoreOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch?: string;
  /** Optional hook for concurrency tests. */
  beforeWrite?: () => Promise<void>;
}

export class GithubJobRequestStore {
  private readonly branch: string;
  private blobShaByRequest = new Map<string, string | null>();

  constructor(private readonly options: GithubJobRequestStoreOptions) {
    this.branch = options.branch ?? DEFAULT_WORKFLOW_STATE_BRANCH;
  }

  private pathFor(requestId: string): string {
    return jobRequestRemotePath(requestId);
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
      if (error instanceof GitHubApiError && error.status === 422) {
        await client.getGitRef(owner, repo, this.branch);
        return;
      }
      throw error;
    }
  }

  async load(requestId: string): Promise<JobRequestRecord | null> {
    const { client, owner, repo } = this.options;
    const path = this.pathFor(requestId);
    const content = await client.getRepositoryContent(
      owner,
      repo,
      path,
      this.branch,
    );
    if (!content) {
      this.blobShaByRequest.set(requestId, null);
      return null;
    }
    this.blobShaByRequest.set(requestId, content.sha);
    const raw = client.decodeRepositoryContent(content);
    let parsed: JobRequestRecord;
    try {
      parsed = JSON.parse(raw) as JobRequestRecord;
    } catch {
      return null;
    }
    if (parsed.kind !== JOB_REQUEST_KIND) {
      return null;
    }
    return parsed;
  }

  async create(record: JobRequestRecord): Promise<JobRequestRecord> {
    if (this.options.beforeWrite) {
      await this.options.beforeWrite();
    }
    await this.ensureBranch();
    const { client, owner, repo } = this.options;
    const path = this.pathFor(record.requestId);

    const existing = await this.load(record.requestId);
    if (existing) {
      throw new JobRequestStoreError(
        "already_exists",
        "Job request envelope already exists.",
      );
    }

    const body = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await client.createOrUpdateRepositoryFile({
        owner,
        repo,
        path,
        branch: this.branch,
        message: `job-request: ${record.requestId} create`,
        content: body,
      });
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 409 || error.status === 422)
      ) {
        throw new JobRequestStoreError(
          "already_exists",
          "Job request envelope already exists.",
        );
      }
      throw error;
    }

    await this.load(record.requestId);
    return structuredClone(record);
  }

  async compareAndSet(input: {
    requestId: string;
    expectedRevision: number;
    next: JobRequestRecord;
  }): Promise<JobRequestRecord | null> {
    if (this.options.beforeWrite) {
      await this.options.beforeWrite();
    }
    await this.ensureBranch();
    const { client, owner, repo } = this.options;
    const path = this.pathFor(input.requestId);

    const current = await this.load(input.requestId);
    const currentRevision = current?.revision ?? -1;
    if (!current) {
      if (input.expectedRevision !== 0) return null;
    } else if (currentRevision !== input.expectedRevision) {
      return null;
    }
    if (input.next.revision !== input.expectedRevision + 1) {
      return null;
    }

    const expectedBlobSha = this.blobShaByRequest.get(input.requestId) ?? null;
    const body = `${JSON.stringify(input.next, null, 2)}\n`;

    try {
      if (expectedBlobSha) {
        await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path,
          branch: this.branch,
          message: `job-request: ${input.requestId} r${input.next.revision}`,
          content: body,
          sha: expectedBlobSha,
        });
      } else {
        await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path,
          branch: this.branch,
          message: `job-request: ${input.requestId} create`,
          content: body,
        });
      }
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 409 || error.status === 422)
      ) {
        await this.load(input.requestId);
        return null;
      }
      throw error;
    }

    await this.load(input.requestId);
    return structuredClone(input.next);
  }
}
