/**
 * Create a private job-request envelope and dispatch only an opaque public payload.
 */

import { GitHubClient } from "../../github/client.js";
import {
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
import { createJobRequest } from "./create.js";
import { GithubJobRequestStore } from "./store.js";

export interface CreateEnvelopeAndDispatchInput {
  issueKey: string;
  phase?: string;
  triggerSource: string;
  linearDeliveryId?: string | null;
  force?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  githubClient?: GitHubClient;
  /** Override dispatch token (defaults to GITHUB_DISPATCH_TOKEN). */
  dispatchToken?: string;
}

export interface CreateEnvelopeAndDispatchResult {
  requestId: string;
  envelopeSchemaVersion: number;
  publicEventType: string;
  executionRepository: string;
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
    input.dispatchToken?.trim() || env.GITHUB_DISPATCH_TOKEN?.trim();
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

  const record = await createJobRequest(store, {
    issueKey: input.issueKey,
    phase: input.phase ?? "auto",
    triggerSource: input.triggerSource,
    linearDeliveryId: input.linearDeliveryId,
    force: input.force,
  });

  const publicEventType = getDispatchEventType();
  const clientPayload: OpaqueJobDispatchPayload = {
    requestId: record.requestId,
    envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    publicEventType,
  };

  const executionSlug = `${execution.owner}/${execution.repo}`;
  await dispatchRepositoryEvent({
    token: dispatchToken,
    repository: executionSlug,
    eventType: publicEventType,
    clientPayload,
    fetchImpl: input.fetchImpl,
  });

  return {
    requestId: record.requestId,
    envelopeSchemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    publicEventType,
    executionRepository: executionSlug,
  };
}
