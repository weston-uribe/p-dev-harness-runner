/**
 * Append-only CAS persistence for coverage lifecycle records.
 */

import {
  GitHubApiError,
  type GitHubClient,
} from "../github/client.js";
import { decideConflictRetry } from "../workflow/state/conflict.js";
import { DEFAULT_WORKFLOW_STATE_BRANCH } from "../public-execution/runtime-repos.js";
import { CursorProvenanceError } from "./errors.js";

export interface GithubProvenanceLifecycleStoreOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch?: string;
  beforeWrite?: () => Promise<void>;
  maxConflictRetries?: number;
  autoCreateBranch?: boolean;
}

export interface PersistImmutableRecordResult {
  idempotent: boolean;
  commitSha: string | null;
  canonicalDigest: string;
}

export class GithubProvenanceLifecycleStore {
  private readonly branch: string;
  private readonly maxConflictRetries: number;
  private readonly autoCreateBranch: boolean;
  private readonly pathCommitSha = new Map<string, string>();

  constructor(private readonly options: GithubProvenanceLifecycleStoreOptions) {
    this.branch = options.branch ?? DEFAULT_WORKFLOW_STATE_BRANCH;
    this.maxConflictRetries = options.maxConflictRetries ?? 3;
    this.autoCreateBranch = options.autoCreateBranch === true;
  }

  get configuredBranch(): string {
    return this.branch;
  }

  async loadRecordAtCommit(
    path: string,
    commitSha: string,
  ): Promise<string | null> {
    const { client, owner, repo } = this.options;
    const content = await client.getRepositoryContent(
      owner,
      repo,
      path,
      commitSha,
    );
    if (!content) {
      return null;
    }
    return client.decodeRepositoryContent(content);
  }

  async loadRecord(path: string): Promise<string | null> {
    return this.loadRecordAtCommit(path, this.branch);
  }

  async persistImmutableRecord(input: {
    path: string;
    body: string;
    canonicalDigest: string;
    commitMessage: string;
  }): Promise<PersistImmutableRecordResult> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      if (this.options.beforeWrite) {
        await this.options.beforeWrite();
      }
      if (this.autoCreateBranch) {
        await this.ensureBranch();
      } else {
        await this.assertBranchExists();
      }

      const existing = await this.loadRecord(input.path);
      if (existing) {
        const existingDigest = digestRecordBody(existing);
        if (existingDigest === input.canonicalDigest) {
          return {
            idempotent: true,
            commitSha: null,
            canonicalDigest: input.canonicalDigest,
          };
        }
        throw new CursorProvenanceError(
          "cursor_provenance_event_divergence",
          `Divergent lifecycle record at ${input.path.split("/").slice(-2).join("/")}.`,
        );
      }

      const { client, owner, repo } = this.options;
      try {
        const result = await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path: input.path,
          branch: this.branch,
          message: input.commitMessage,
          content: input.body,
        });
        if (result.commitSha) {
          this.pathCommitSha.set(input.path, result.commitSha);
        }
        return {
          idempotent: false,
          commitSha: result.commitSha,
          canonicalDigest: input.canonicalDigest,
        };
      } catch (error) {
        if (
          error instanceof GitHubApiError &&
          (error.status === 409 || error.status === 422)
        ) {
          const decision = decideConflictRetry({
            attempt,
            maxRetries: this.maxConflictRetries,
            casFailed: true,
          });
          if (!decision.retry) {
            const raced = await this.loadRecord(input.path);
            if (raced) {
              const racedDigest = digestRecordBody(raced);
              if (racedDigest === input.canonicalDigest) {
                return {
                  idempotent: true,
                  commitSha: null,
                  canonicalDigest: input.canonicalDigest,
                };
              }
              throw new CursorProvenanceError(
                "cursor_provenance_event_divergence",
                "Divergent lifecycle record after CAS conflict.",
              );
            }
            throw new CursorProvenanceError(
              "cursor_provenance_state_unavailable",
              "Lifecycle record CAS conflict exhausted.",
            );
          }
          continue;
        }
        if (error instanceof CursorProvenanceError) {
          throw error;
        }
        throw new CursorProvenanceError(
          "cursor_provenance_state_unavailable",
          "Lifecycle record write failed.",
        );
      }
    }
  }

  commitShaForPath(path: string): string | null {
    return this.pathCommitSha.get(path) ?? null;
  }

  async resolveCommitShaForPath(path: string): Promise<string | null> {
    const cached = this.pathCommitSha.get(path);
    if (cached) {
      return cached;
    }
    const { client, owner, repo } = this.options;
    const commits = await client.listCommits(owner, repo, {
      sha: this.branch,
      path,
      perPage: 1,
    });
    const sha = commits[0]?.sha ?? null;
    if (sha) {
      this.pathCommitSha.set(path, sha);
    }
    return sha;
  }

  private async assertBranchExists(): Promise<void> {
    const { client, owner, repo } = this.options;
    try {
      await client.getGitRef(owner, repo, this.branch);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new CursorProvenanceError(
          "cursor_provenance_bootstrap_branch_missing",
          `Configured provenance state branch ${this.branch} does not exist.`,
        );
      }
      throw error;
    }
  }

  private async ensureBranch(): Promise<void> {
    const { client, owner, repo } = this.options;
    try {
      await client.getGitRef(owner, repo, this.branch);
      return;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
    }
    if (!this.autoCreateBranch) {
      throw new CursorProvenanceError(
        "cursor_provenance_bootstrap_branch_missing",
        `Configured provenance state branch ${this.branch} does not exist.`,
      );
    }
    const repoInfo = await client.getRepository(owner, repo);
    const defaultBranch = repoInfo.default_branch?.trim() || "main";
    const defaultRef = await client.getGitRef(owner, repo, defaultBranch);
    await client.createGitRef(owner, repo, this.branch, defaultRef.object.sha);
  }
}

export class InMemoryProvenanceLifecycleStore {
  private readonly records = new Map<string, string>();
  private readonly commitByPath = new Map<string, string>();
  private commitCounter = 0;

  async loadRecord(path: string): Promise<string | null> {
    return this.records.get(path) ?? null;
  }

  async loadRecordAtCommit(
    path: string,
    _commitSha: string,
  ): Promise<string | null> {
    return this.loadRecord(path);
  }

  async persistImmutableRecord(input: {
    path: string;
    body: string;
    canonicalDigest: string;
    commitMessage: string;
  }): Promise<PersistImmutableRecordResult> {
    const existing = this.records.get(input.path);
    if (existing) {
      const existingDigest = digestRecordBody(existing);
      if (existingDigest === input.canonicalDigest) {
        return {
          idempotent: true,
          commitSha: null,
          canonicalDigest: input.canonicalDigest,
        };
      }
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Divergent lifecycle record (in-memory).",
      );
    }
    this.records.set(input.path, input.body);
    this.commitCounter += 1;
    const commitSha = `mem-${this.commitCounter.toString(16).padStart(8, "0")}`;
    this.commitByPath.set(input.path, commitSha);
    return {
      idempotent: false,
      commitSha,
      canonicalDigest: input.canonicalDigest,
    };
  }

  commitShaForPath(path: string): string | null {
    return this.commitByPath.get(path) ?? null;
  }

  listPaths(): string[] {
    return [...this.records.keys()];
  }

  clear(): void {
    this.records.clear();
    this.commitByPath.clear();
    this.commitCounter = 0;
  }
}

export type ProvenanceLifecycleStore =
  | GithubProvenanceLifecycleStore
  | InMemoryProvenanceLifecycleStore;

export interface ProvenanceLifecycleStoreInterface {
  loadRecord(path: string): Promise<string | null>;
  loadRecordAtCommit(path: string, commitSha: string): Promise<string | null>;
  persistImmutableRecord(input: {
    path: string;
    body: string;
    canonicalDigest: string;
    commitMessage: string;
  }): Promise<PersistImmutableRecordResult>;
  listPaths?(): string[];
  commitShaForPath?(path: string): string | null;
  resolveCommitShaForPath?(path: string): Promise<string | null>;
}

function digestRecordBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const digestKeys = [
      "canonicalPayloadDigest",
      "envelopeDigest",
      "sealDigest",
      "gapDigest",
      "supersessionDigest",
      "evidenceDigest",
    ] as const;
    for (const key of digestKeys) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const proofDigest = activationHistoryProofDigestFromBody(parsed);
    if (proofDigest) {
      return proofDigest;
    }
  } catch {
    // fall through
  }
  return body;
}

function activationHistoryProofDigestFromBody(
  parsed: Record<string, unknown>,
): string | null {
  if (parsed.kind !== "p-dev.cursor-cloud-agent-activation-history-proof.v1") {
    return null;
  }
  if (typeof parsed.evidenceDigest === "string" && parsed.evidenceDigest) {
    return parsed.evidenceDigest;
  }
  return null;
}
