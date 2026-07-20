/**
 * Create a private job-request envelope and dispatch only an opaque public payload.
 */

import { GitHubClient } from "../../github/client.js";
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
import { JOB_REQUEST_SCHEMA_VERSION } from "./types.js";
import { createJobRequest, buildJobRequestRecord } from "./create.js";
import { GithubJobRequestStore, JobRequestStoreError } from "./store.js";
import { attemptJobRequestAcknowledgement } from "./acknowledge.js";
import { resolveJobRequestId } from "./request-id.js";

export interface CreateEnvelopeAndDispatchInput {
  issueKey: string;
  phase?: string;
  triggerSource: string;
  linearDeliveryId?: string | null;
  force?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  githubClient?: GitHubClient;
  /** Override dispatch token (defaults to GITHUB_DISPATCH_TOKEN ?? HARNESS_GITHUB_TOKEN). */
  dispatchToken?: string;
  reviewSubjectIdentity?: string | null;
  /** When false, skip ack lifecycle (internal/harness-owned dispatches). */
  ackRequired?: boolean;
  /** Skip repository_dispatch (e.g. dry create). */
  skipDispatch?: boolean;
}

export interface CreateEnvelopeAndDispatchResult {
  requestId: string;
  envelopeSchemaVersion: number;
  publicEventType: string;
  executionRepository: string;
  duplicate: boolean;
  dispatched: boolean;
  ackConfirmed: boolean;
}

export async function createEnvelopeAndDispatch(
  input: CreateEnvelopeAndDispatchInput,
): Promise<CreateEnvelopeAndDispatchResult> {
  const env = input.env ?? process.env;
  const stateToken = resolveStateGithubToken(env);
  if (!stateToken) {
    throw new Error("missing_state_token");
  }

  const jobRepo = resolveJobRequestRepository(env);
  if (!jobRepo) {
    throw new Error("missing_job_request_repository");
  }

  const execution =
    resolveExecutionRepository(env) ??
    (() => {
      const slug = getDispatchRepository();
      const [owner, repo] = slug.split("/");
      return owner && repo ? { owner, repo } : null;
    })();
  if (!execution) {
    throw new Error("missing_execution_repository");
  }

  const dispatchToken =
    input.dispatchToken?.trim() || resolveDispatchGithubToken(env);
  if (!dispatchToken) {
    throw new Error("missing_dispatch_token");
  }

  const client = input.githubClient ?? new GitHubClient({ token: stateToken });
  const store = new GithubJobRequestStore({
    client,
    owner: jobRepo.owner,
    repo: jobRepo.repo,
    branch: resolveWorkflowStateBranch(env),
  });
  await store.ensureBranch();

  const requestId = resolveJobRequestId({
    linearDeliveryId: input.linearDeliveryId,
  });
  const existing = await store.load(requestId);
  if (existing) {
    return {
      requestId: existing.requestId,
      envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
      publicEventType: getDispatchEventType(),
      executionRepository: `${execution.owner}/${execution.repo}`,
      duplicate: true,
      dispatched: false,
      ackConfirmed: Boolean(existing.ack?.ackConfirmedAt),
    };
  }

  let record;
  try {
    record = await createJobRequest(store, {
      issueKey: input.issueKey,
      phase: input.phase ?? "auto",
      triggerSource: input.triggerSource,
      linearDeliveryId: input.linearDeliveryId,
      force: input.force,
      requestId,
      reviewSubjectIdentity: input.reviewSubjectIdentity,
      ackRequired: input.ackRequired ?? true,
    });
  } catch (error) {
    if (error instanceof JobRequestStoreError && error.code === "already_exists") {
      const raced = await store.load(requestId);
      if (raced) {
        return {
          requestId: raced.requestId,
          envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
          publicEventType: getDispatchEventType(),
          executionRepository: `${execution.owner}/${execution.repo}`,
          duplicate: true,
          dispatched: false,
          ackConfirmed: Boolean(raced.ack?.ackConfirmedAt),
        };
      }
    }
    throw error;
  }

  let ackConfirmed = false;
  if (record.ack?.ackRequired) {
    const ackResult = await attemptJobRequestAcknowledgement({
      store,
      record,
      linearApiKey: env.LINEAR_API_KEY,
      source: "bridge",
      generation: Date.parse(record.createdAt) || Date.now(),
    });
    record = ackResult.record;
    ackConfirmed = ackResult.confirmed;
  }

  const publicEventType = getDispatchEventType();
  const clientPayload: OpaqueJobDispatchPayload = {
    requestId: record.requestId,
    envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    publicEventType,
  };

  const executionSlug = `${execution.owner}/${execution.repo}`;
  let dispatched = false;
  if (!input.skipDispatch) {
    await dispatchRepositoryEvent({
      token: dispatchToken,
      repository: executionSlug,
      eventType: publicEventType,
      clientPayload,
      fetchImpl: input.fetchImpl,
    });
    dispatched = true;
  }

  return {
    requestId: record.requestId,
    envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    publicEventType,
    executionRepository: executionSlug,
    duplicate: false,
    dispatched,
    ackConfirmed,
  };
}

/** Create + dispatch an explicit code_review job (no Linear ack; harness-owned). */
export async function createCodeReviewJobAndDispatch(input: {
  issueKey: string;
  reviewSubjectIdentity: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  githubClient?: GitHubClient;
  dispatchToken?: string;
}): Promise<CreateEnvelopeAndDispatchResult> {
  return createEnvelopeAndDispatch({
    issueKey: input.issueKey,
    phase: "code_review",
    triggerSource: "harness_code_review_handoff",
    linearDeliveryId: `cr-subject:${input.reviewSubjectIdentity}`,
    reviewSubjectIdentity: input.reviewSubjectIdentity,
    ackRequired: false,
    env: input.env,
    fetchImpl: input.fetchImpl,
    githubClient: input.githubClient,
    dispatchToken: input.dispatchToken,
  });
}

export { buildJobRequestRecord };
