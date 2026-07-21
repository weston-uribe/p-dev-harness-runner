/**
 * Deterministic opaque merge job create/dispatch for reconcile + CLI.
 */

import { GitHubClient } from "../../github/client.js";
import { parsePrUrl } from "../../github/pr-url.js";
import {
  resolveDispatchGithubToken,
  resolveExecutionRepository,
  resolveJobRequestRepository,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
} from "../../public-execution/runtime-repos.js";
import {
  dispatchRepositoryEvent,
  getDispatchEventType,
  getDispatchRepository,
} from "../../webhook/dispatch-github.js";
import type { OpaqueJobDispatchPayload } from "../../webhook/types.js";
import {
  failStalePrePhaseClaim,
  reopenFailedJobRequestForRetry,
} from "./claim.js";
import { createJobRequest } from "./create.js";
import { resolveMergeJobRequestId } from "./merge-request-id.js";
import { GithubJobRequestStore, JobRequestStoreError } from "./store.js";
import {
  JOB_REQUEST_SCHEMA_VERSION,
  type JobRequestRecord,
} from "./types.js";

export interface DispatchMergeReconcileInput {
  issueKey: string;
  targetRepository: string;
  prNumber: number;
  prUrl: string;
  reviewedHeadSha: string;
  approvedReviewDecisionIdentity: string;
  /** When true, skip repository_dispatch (evaluate-only). */
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  githubClient?: GitHubClient;
  dispatchToken?: string;
  /**
   * Optional live GitHub truth: PR already merged means no dispatch.
   * When omitted, the helper may fetch once using GITHUB_TOKEN.
   */
  pullRequestMerged?: boolean | null;
  /** When true, do not reclaim stale claimed / retryable failed envelopes. */
  hasActiveAgentOrLease?: boolean;
}

export type MergeReconcileDispatchOutcome =
  | "dispatched"
  | "already_pending"
  | "already_claimed"
  | "already_dispatched"
  | "already_completed"
  | "pr_already_merged"
  | "dry_run"
  | "missing_dispatch_token"
  | "missing_state_token";

export interface DispatchMergeReconcileResult {
  requestId: string;
  outcome: MergeReconcileDispatchOutcome;
  dispatched: boolean;
  record: JobRequestRecord | null;
}

function ensureDispatchLifecycle(record: JobRequestRecord): JobRequestRecord {
  if (!record.dispatch) {
    return {
      ...record,
      dispatch: {
        attemptedAt: null,
        confirmedAt: null,
        failureCategory: null,
      },
    };
  }
  return record;
}

async function detectPullMerged(
  input: DispatchMergeReconcileInput,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  if (typeof input.pullRequestMerged === "boolean") {
    return input.pullRequestMerged;
  }
  const token =
    env.GITHUB_TOKEN?.trim() ||
    env.GITHUB_DISPATCH_TOKEN?.trim() ||
    input.dispatchToken?.trim();
  if (!token) return false;
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) return false;
  try {
    const github = input.githubClient ?? new GitHubClient({ token });
    const pull = await github.getPullRequest(
      parsed.owner,
      parsed.repo,
      parsed.pullNumber,
    );
    return Boolean(pull.merged_at ?? pull.merged);
  } catch {
    return false;
  }
}

export async function dispatchMergeReconcileJob(
  input: DispatchMergeReconcileInput,
): Promise<DispatchMergeReconcileResult> {
  const env = input.env ?? process.env;
  const requestId = resolveMergeJobRequestId({
    issueKey: input.issueKey,
    targetRepository: input.targetRepository,
    prNumber: input.prNumber,
    reviewedHeadSha: input.reviewedHeadSha,
    approvedReviewDecisionIdentity: input.approvedReviewDecisionIdentity,
  });

  if (await detectPullMerged(input, env)) {
    return {
      requestId,
      outcome: "pr_already_merged",
      dispatched: false,
      record: null,
    };
  }

  const stateToken = resolveStateGithubToken(env);
  if (!stateToken) {
    return {
      requestId,
      outcome: "missing_state_token",
      dispatched: false,
      record: null,
    };
  }

  const jobRepo = resolveJobRequestRepository(env);
  if (!jobRepo) {
    return {
      requestId,
      outcome: "missing_state_token",
      dispatched: false,
      record: null,
    };
  }

  const execution =
    resolveExecutionRepository(env) ??
    (() => {
      const slug = getDispatchRepository();
      const [owner, repo] = slug.split("/");
      return owner && repo ? { owner, repo } : null;
    })();
  if (!execution) {
    return {
      requestId,
      outcome: "missing_dispatch_token",
      dispatched: false,
      record: null,
    };
  }

  const dispatchToken =
    input.dispatchToken?.trim() || resolveDispatchGithubToken(env);
  if (!dispatchToken && !input.dryRun) {
    return {
      requestId,
      outcome: "missing_dispatch_token",
      dispatched: false,
      record: null,
    };
  }

  const client = input.githubClient ?? new GitHubClient({ token: stateToken });
  const store = new GithubJobRequestStore({
    client,
    owner: jobRepo.owner,
    repo: jobRepo.repo,
    branch: resolveWorkflowStateBranch(env),
  });
  await store.ensureBranch();

  let record = await store.load(requestId);
  if (!record) {
    if (input.dryRun) {
      return {
        requestId,
        outcome: "dry_run",
        dispatched: false,
        record: null,
      };
    }
    try {
      record = await createJobRequest(store, {
        issueKey: input.issueKey.toUpperCase(),
        phase: "merge",
        triggerSource: "merge_reconcile",
        linearDeliveryId: `merge-subject:${requestId}`,
        requestId,
        ackRequired: false,
      });
    } catch (error) {
      const code =
        error instanceof JobRequestStoreError
          ? error.code
          : (error as { code?: string } | null)?.code;
      if (code === "already_exists") {
        record = await store.load(requestId);
      } else {
        throw error;
      }
    }
  }

  if (!record) {
    return {
      requestId,
      outcome: "missing_state_token",
      dispatched: false,
      record: null,
    };
  }

  record = ensureDispatchLifecycle(record);

  if (record.state === "completed") {
    return {
      requestId,
      outcome: "already_completed",
      dispatched: false,
      record,
    };
  }
  if (record.state === "claimed") {
    const reclaimed = await failStalePrePhaseClaim(store, {
      requestId,
      hasActiveAgentOrLease: input.hasActiveAgentOrLease,
      completionState: "stale_prephase_claim",
    });
    if (!reclaimed) {
      return {
        requestId,
        outcome: "already_claimed",
        dispatched: false,
        record,
      };
    }
    record = reclaimed;
  }
  if (record.state === "failed") {
    const reopened = await reopenFailedJobRequestForRetry(store, { requestId });
    if (!reopened) {
      return {
        requestId,
        outcome: "already_completed",
        dispatched: false,
        record,
      };
    }
    record = ensureDispatchLifecycle(reopened);
  }
  if (record.dispatch?.confirmedAt) {
    return {
      requestId,
      outcome: "already_dispatched",
      dispatched: false,
      record,
    };
  }
  if (record.state === "pending" && record.dispatch?.attemptedAt && !record.dispatch.confirmedAt) {
    // Ambiguous: GitHub may have accepted dispatch without persistence. Do not
    // send a second repository_dispatch; treat as already in flight.
    return {
      requestId,
      outcome: "already_dispatched",
      dispatched: false,
      record,
    };
  }

  if (input.dryRun) {
    return {
      requestId,
      outcome: "dry_run",
      dispatched: false,
      record,
    };
  }

  const attemptedAt = new Date().toISOString();
  const attempting: JobRequestRecord = {
    ...record,
    dispatch: {
      attemptedAt,
      confirmedAt: null,
      failureCategory: null,
    },
    revision: record.revision + 1,
  };
  const casAttempt = await store.compareAndSet({
    requestId,
    expectedRevision: record.revision,
    next: attempting,
  });
  record = casAttempt ?? attempting;

  // Lost the CAS race to another reconciler that moved the envelope forward.
  if (!casAttempt) {
    const latest = await store.load(requestId);
    if (latest?.dispatch?.confirmedAt || latest?.state === "claimed" || latest?.state === "completed") {
      return {
        requestId,
        outcome:
          latest.state === "completed"
            ? "already_completed"
            : latest.state === "claimed"
              ? "already_claimed"
              : "already_dispatched",
        dispatched: false,
        record: latest,
      };
    }
  }

  const publicEventType = getDispatchEventType();
  const clientPayload: OpaqueJobDispatchPayload = {
    requestId: record.requestId,
    envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    publicEventType,
  };

  await dispatchRepositoryEvent({
    token: dispatchToken!,
    repository: `${execution.owner}/${execution.repo}`,
    eventType: publicEventType,
    clientPayload,
    fetchImpl: input.fetchImpl,
  });

  const confirmed: JobRequestRecord = {
    ...record,
    dispatch: {
      attemptedAt: record.dispatch?.attemptedAt ?? attemptedAt,
      confirmedAt: new Date().toISOString(),
      failureCategory: null,
    },
    revision: record.revision + 1,
  };
  const casConfirm = await store.compareAndSet({
    requestId,
    expectedRevision: record.revision,
    next: confirmed,
  });

  return {
    requestId,
    outcome: "dispatched",
    dispatched: true,
    record: casConfirm ?? confirmed,
  };
}
