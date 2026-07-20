/**
 * Idempotent Linear acknowledgement for accepted job requests.
 */

import { createLinearClient } from "../../linear/writer.js";
import { fetchLinearIssue } from "../../linear/client.js";
import {
  acknowledgeIssueReceived,
  type UpsertRunStatusCommentResult,
} from "../../linear/run-status-comment.js";
import type { GithubJobRequestStore } from "./store.js";
import type {
  JobRequestAckFailureCategory,
  JobRequestAckSource,
  JobRequestRecord,
} from "./types.js";

export interface AttemptJobRequestAckInput {
  store: GithubJobRequestStore;
  record: JobRequestRecord;
  linearApiKey: string | null | undefined;
  source: JobRequestAckSource;
  /** Stable generation for causal run-status compare-before-write. */
  generation: number;
  now?: Date;
}

export interface AttemptJobRequestAckResult {
  record: JobRequestRecord;
  confirmed: boolean;
  alreadyConfirmed: boolean;
  failureCategory: JobRequestAckFailureCategory | null;
  upsert?: UpsertRunStatusCommentResult;
}

function withAckPatch(
  record: JobRequestRecord,
  patch: Partial<NonNullable<JobRequestRecord["ack"]>>,
  revisionBump: boolean,
): JobRequestRecord {
  const baseAck = record.ack ?? {
    ackRequired: true,
    acceptedAt: record.createdAt,
    ackAttemptedAt: null,
    ackConfirmedAt: null,
    ackSource: null,
    ackFailureCategory: null,
  };
  return {
    ...record,
    revision: revisionBump ? record.revision + 1 : record.revision,
    ack: {
      ...baseAck,
      ...patch,
    },
  };
}

export async function attemptJobRequestAcknowledgement(
  input: AttemptJobRequestAckInput,
): Promise<AttemptJobRequestAckResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  let record = input.record;

  if (record.ack?.ackConfirmedAt) {
    return {
      record,
      confirmed: true,
      alreadyConfirmed: true,
      failureCategory: null,
    };
  }

  if (!record.ack?.ackRequired) {
    return {
      record,
      confirmed: true,
      alreadyConfirmed: true,
      failureCategory: null,
    };
  }

  const attempted = withAckPatch(
    record,
    { ackAttemptedAt: nowIso },
    true,
  );
  const casAttempted = await input.store.compareAndSet({
    requestId: record.requestId,
    expectedRevision: record.revision,
    next: attempted,
  });
  record = casAttempted ?? attempted;

  if (!input.linearApiKey?.trim()) {
    const failed = withAckPatch(
      record,
      { ackFailureCategory: "missing_linear_api_key" },
      true,
    );
    const casFailed = await input.store.compareAndSet({
      requestId: record.requestId,
      expectedRevision: record.revision,
      next: failed,
    });
    return {
      record: casFailed ?? failed,
      confirmed: false,
      alreadyConfirmed: false,
      failureCategory: "missing_linear_api_key",
    };
  }

  try {
    const issue = await fetchLinearIssue(record.issueKey, input.linearApiKey);
    const client = createLinearClient(input.linearApiKey);
    const upsert = await acknowledgeIssueReceived(client, issue.id, {
      runId: record.requestId,
      deliveryId: record.linearDeliveryId,
      generation: input.generation,
      stateRevision: 0,
      phase: "accepted",
      outcomeClass: "accepted",
      ownedActiveClaim: true,
    });

    const confirmedAt = (input.now ?? new Date()).toISOString();
    const confirmed = withAckPatch(
      record,
      {
        ackConfirmedAt: confirmedAt,
        ackSource: input.source,
        ackFailureCategory: null,
      },
      true,
    );
    const casConfirmed = await input.store.compareAndSet({
      requestId: record.requestId,
      expectedRevision: record.revision,
      next: confirmed,
    });
    return {
      record: casConfirmed ?? confirmed,
      confirmed: true,
      alreadyConfirmed: false,
      failureCategory: null,
      upsert,
    };
  } catch {
    const failed = withAckPatch(
      record,
      { ackFailureCategory: "linear_write_failed" },
      true,
    );
    const casFailed = await input.store.compareAndSet({
      requestId: record.requestId,
      expectedRevision: record.revision,
      next: failed,
    });
    return {
      record: casFailed ?? failed,
      confirmed: false,
      alreadyConfirmed: false,
      failureCategory: "linear_write_failed",
    };
  }
}
