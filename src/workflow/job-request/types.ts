export const JOB_REQUEST_SCHEMA_VERSION = 1;
export const JOB_REQUEST_KIND = "p-dev-job-request-v1";

export type JobRequestState =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "expired";

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
}
