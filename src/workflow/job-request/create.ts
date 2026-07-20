import {
  JOB_REQUEST_KIND,
  JOB_REQUEST_SCHEMA_VERSION,
  type JobRequestRecord,
} from "./types.js";
import { computeJobRequestDedupeIdentity } from "./dedupe.js";
import { resolveJobRequestId } from "./request-id.js";
import type { GithubJobRequestStore } from "./store.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface BuildJobRequestRecordInput {
  issueKey: string;
  phase: string;
  triggerSource: string;
  linearDeliveryId?: string | null;
  force?: boolean;
  now?: Date;
  ttlMs?: number;
  requestId?: string;
  reviewSubjectIdentity?: string | null;
  ackRequired?: boolean;
}

export function buildJobRequestRecord(
  input: BuildJobRequestRecordInput,
): JobRequestRecord {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const requestId = resolveJobRequestId({
    linearDeliveryId: input.linearDeliveryId,
    requestId: input.requestId,
  });
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const ackRequired = input.ackRequired ?? true;

  return {
    kind: JOB_REQUEST_KIND,
    schemaVersion: JOB_REQUEST_SCHEMA_VERSION,
    requestId,
    issueKey: input.issueKey.trim(),
    phase: input.phase.trim(),
    triggerSource: input.triggerSource.trim(),
    linearDeliveryId: input.linearDeliveryId?.trim() || null,
    force: input.force ?? false,
    createdAt,
    expiresAt,
    state: "pending",
    claimIdentity: null,
    completionState: null,
    dedupeIdentity: computeJobRequestDedupeIdentity({
      issueKey: input.issueKey,
      phase: input.phase,
      linearDeliveryId: input.linearDeliveryId,
      triggerSource: input.triggerSource,
    }),
    revision: 0,
    reviewSubjectIdentity: input.reviewSubjectIdentity?.trim() || null,
    ack: {
      ackRequired,
      acceptedAt: createdAt,
      ackAttemptedAt: null,
      ackConfirmedAt: null,
      ackSource: null,
      ackFailureCategory: null,
    },
  };
}

export async function createJobRequest(
  store: GithubJobRequestStore,
  input: BuildJobRequestRecordInput,
): Promise<JobRequestRecord> {
  const record = buildJobRequestRecord(input);
  return store.create(record);
}
