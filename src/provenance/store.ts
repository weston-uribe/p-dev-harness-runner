/**
 * Immutable create-only provenance event store backed by GitHub Contents API.
 */

import {
  GitHubApiError,
  type GitHubClient,
} from "../github/client.js";
import { decideConflictRetry } from "../workflow/state/conflict.js";
import { DEFAULT_WORKFLOW_STATE_BRANCH } from "../public-execution/runtime-repos.js";
import { CursorProvenanceError } from "./errors.js";
import type { ProvenanceEvent } from "./events.js";
import { provenanceEventRemotePath } from "./paths.js";

export interface GithubProvenanceEventStoreOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch?: string;
  beforeWrite?: () => Promise<void>;
  maxConflictRetries?: number;
  /**
   * When false (production default), missing branch fails instead of being created.
   * Tests may set true to exercise ensureBranch explicitly.
   */
  autoCreateBranch?: boolean;
}

export interface PersistEventResult {
  event: ProvenanceEvent;
  idempotent: boolean;
  commitSha: string | null;
}

export class GithubProvenanceEventStore {
  private readonly branch: string;
  private readonly maxConflictRetries: number;
  private readonly autoCreateBranch: boolean;

  constructor(private readonly options: GithubProvenanceEventStoreOptions) {
    this.branch = options.branch ?? DEFAULT_WORKFLOW_STATE_BRANCH;
    this.maxConflictRetries = options.maxConflictRetries ?? 3;
    this.autoCreateBranch = options.autoCreateBranch === true;
  }

  get configuredBranch(): string {
    return this.branch;
  }

  get configuredOwner(): string {
    return this.options.owner;
  }

  get configuredRepo(): string {
    return this.options.repo;
  }

  /** Read-only: require the configured branch to already exist. */
  async assertBranchExists(): Promise<void> {
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

  /**
   * Explicit create-if-missing. Not used by production persist path.
   */
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
    if (!this.autoCreateBranch) {
      throw new CursorProvenanceError(
        "cursor_provenance_bootstrap_branch_missing",
        `Configured provenance state branch ${this.branch} does not exist.`,
      );
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

  async loadEvent(path: string): Promise<ProvenanceEvent | null> {
    const { client, owner, repo } = this.options;
    const content = await client.getRepositoryContent(
      owner,
      repo,
      path,
      this.branch,
    );
    if (!content) {
      return null;
    }
    const raw = client.decodeRepositoryContent(content);
    try {
      return JSON.parse(raw) as ProvenanceEvent;
    } catch {
      throw new CursorProvenanceError(
        "cursor_provenance_state_unavailable",
        "Malformed provenance event in state repository.",
      );
    }
  }

  /**
   * Create-if-absent with digest-idempotent retry semantics.
   * Never overwrites a divergent event.
   */
  async persistImmutableEvent(input: {
    event: ProvenanceEvent;
    bindingOrStageId?: string;
    commitMessage: string;
  }): Promise<PersistEventResult> {
    const path = provenanceEventRemotePath({
      launchAttemptId: input.event.launchAttemptId,
      eventType: input.event.eventType,
      bindingOrStageId: input.bindingOrStageId,
    });

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

      const existing = await this.loadEvent(path);
      if (existing) {
        if (
          existing.canonicalSemanticDigest ===
          input.event.canonicalSemanticDigest
        ) {
          return {
            event: existing,
            idempotent: true,
            commitSha: null,
          };
        }
        throw new CursorProvenanceError(
          "cursor_provenance_event_divergence",
          `Divergent provenance event at ${path.split("/").slice(-2).join("/")}.`,
        );
      }

      const body = `${JSON.stringify(input.event, null, 2)}\n`;
      const { client, owner, repo } = this.options;
      try {
        const result = await client.createOrUpdateRepositoryFile({
          owner,
          repo,
          path,
          branch: this.branch,
          message: input.commitMessage,
          content: body,
        });
        return {
          event: input.event,
          idempotent: false,
          commitSha: result.commitSha,
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
            // Final conflict: re-load and apply idempotency/divergence rules.
            const raced = await this.loadEvent(path);
            if (
              raced &&
              raced.canonicalSemanticDigest ===
                input.event.canonicalSemanticDigest
            ) {
              return { event: raced, idempotent: true, commitSha: null };
            }
            if (raced) {
              throw new CursorProvenanceError(
                "cursor_provenance_event_divergence",
                "Divergent provenance event after CAS conflict.",
              );
            }
            throw new CursorProvenanceError(
              "cursor_provenance_state_unavailable",
              "Provenance state CAS conflict exhausted.",
            );
          }
          continue;
        }
        if (error instanceof CursorProvenanceError) {
          throw error;
        }
        throw new CursorProvenanceError(
          "cursor_provenance_state_unavailable",
          "Provenance state write failed.",
        );
      }
    }
  }
}

/** In-memory store for loopback tests. */
export class InMemoryProvenanceEventStore {
  private readonly events = new Map<string, ProvenanceEvent>();

  async persistImmutableEvent(input: {
    event: ProvenanceEvent;
    bindingOrStageId?: string;
    commitMessage: string;
  }): Promise<PersistEventResult> {
    const path = provenanceEventRemotePath({
      launchAttemptId: input.event.launchAttemptId,
      eventType: input.event.eventType,
      bindingOrStageId: input.bindingOrStageId,
    });
    const existing = this.events.get(path);
    if (existing) {
      if (
        existing.canonicalSemanticDigest ===
        input.event.canonicalSemanticDigest
      ) {
        return { event: existing, idempotent: true, commitSha: null };
      }
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Divergent provenance event (in-memory).",
      );
    }
    this.events.set(path, structuredClone(input.event));
    return {
      event: input.event,
      idempotent: false,
      commitSha: "mem-" + path.length.toString(16),
    };
  }

  async loadEvent(path: string): Promise<ProvenanceEvent | null> {
    return this.events.get(path) ?? null;
  }

  listEvents(): ProvenanceEvent[] {
    return [...this.events.values()].map((e) => structuredClone(e));
  }

  clear(): void {
    this.events.clear();
  }
}

export type ProvenanceEventStore =
  | GithubProvenanceEventStore
  | InMemoryProvenanceEventStore;
