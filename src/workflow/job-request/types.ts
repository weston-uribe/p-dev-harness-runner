export const JOB_REQUEST_SCHEMA_VERSION = 1;
export const JOB_REQUEST_KIND = "p-dev-job-request-v1";

export type JobRequestState =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "expired";

export type JobRequestAckSource = "bridge" | "runner_fallback";

export type JobRequestAckFailureCategory =
  | "missing_linear_api_key"
  | "linear_write_failed"
  | "issue_resolve_failed"
  | "unknown";

export interface JobRequestAckLifecycle {
  ackRequired: boolean;
  acceptedAt: string;
  ackAttemptedAt: string | null;
  ackConfirmedAt: string | null;
  ackSource: JobRequestAckSource | null;
  ackFailureCategory: JobRequestAckFailureCategory | null;
}

export interface JobRequestRecord {
  kind: typeof JOB_REQUEST_KIND;
  schemaVersion: typeof JOB_REQUEST_SCHEMA_VERSION;
  requestId: string;
  issueKey: string;
  phase: string;
  triggerSource: string;
  linearDeliveryId: string | null;
  force: boolean;
  createdAt: string;
  expiresAt: string;
  state: JobRequestState;
  claimIdentity: string | null;
  completionState: string | null;
  dedupeIdentity: string;
  revision: number;
  /** Review-subject identity for explicit code_review handoff jobs. */
  reviewSubjectIdentity?: string | null;
  ack?: JobRequestAckLifecycle;
}
