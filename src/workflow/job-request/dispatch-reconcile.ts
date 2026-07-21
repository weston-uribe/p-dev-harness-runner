/**
 * Opaque reconcile dispatch for all non-specialized workflow phases.
 * Never emits legacy { issueKey, statusName } repository_dispatch payloads.
 */

import { createHash } from "node:crypto";
import type { GitHubClient } from "../../github/client.js";
import {
  createEnvelopeAndDispatch,
  type CreateEnvelopeAndDispatchResult,
} from "./dispatch-opaque.js";

export function buildReconcileDeliveryId(input: {
  phase: string;
  issueKey: string;
  workflowStateRevision: number | null;
  linearStatus?: string | null;
  detail?: string | null;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "harness_reconcile_workflow",
        input.phase.trim(),
        input.issueKey.trim().toUpperCase(),
        String(input.workflowStateRevision ?? 0),
        (input.linearStatus ?? "").trim().toLowerCase(),
        (input.detail ?? "").trim(),
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `reconcile:${input.phase.trim()}:${digest}`;
}

export async function createReconcileJobAndDispatch(input: {
  issueKey: string;
  phase: string;
  workflowStateRevision: number | null;
  linearStatus?: string | null;
  detail?: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  githubClient?: GitHubClient;
  dispatchToken?: string;
}): Promise<CreateEnvelopeAndDispatchResult> {
  const linearDeliveryId = buildReconcileDeliveryId({
    phase: input.phase,
    issueKey: input.issueKey,
    workflowStateRevision: input.workflowStateRevision,
    linearStatus: input.linearStatus,
    detail: input.detail,
  });
  return createEnvelopeAndDispatch({
    issueKey: input.issueKey,
    phase: input.phase,
    triggerSource: "harness_reconcile_workflow",
    linearDeliveryId,
    ackRequired: false,
    env: input.env,
    fetchImpl: input.fetchImpl,
    githubClient: input.githubClient,
    dispatchToken: input.dispatchToken,
  });
}

/** Guard: opaque public payloads must always carry a non-empty requestId. */
export function assertOpaqueDispatchPayload(payload: {
  requestId?: unknown;
}): string {
  const requestId =
    typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  if (!requestId) {
    throw new Error(
      "opaque_dispatch_missing_request_id: reconcile must never dispatch without a durable requestId",
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw new Error(
      `opaque_dispatch_invalid_request_id: ${requestId} is not gate-safe`,
    );
  }
  return requestId;
}
