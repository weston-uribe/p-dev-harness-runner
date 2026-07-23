export interface LinearWebhookHeaders {
  signature: string | null;
  deliveryId: string | null;
  eventType: string | null;
  timestamp: string | null;
}

export interface ParsedLinearIssueWebhook {
  issueKey: string | null;
  issueId: string | null;
  issueUrl: string | null;
  teamId: string | null;
  projectId: string | null;
  action: string;
  statusName: string | null;
  previousStatusName: string | null;
  statusChanged: boolean;
  linearDeliveryId: string | null;
  linearWebhookId: string | null;
  actorSummary: string | null;
  eventType: string;
}

export interface ParsedLinearCommentWebhook {
  issueKey: string | null;
  issueId: string | null;
  commentId: string | null;
  commentBody: string | null;
  action: string;
  eventType: "Comment";
  linearDeliveryId: string | null;
  linearWebhookId: string | null;
  actorSummary: string | null;
}

export type WebhookIgnoreReason =
  | "ignored_event"
  | "ignored_status"
  | "missing_issue_key"
  | "linear_team_project_not_configured"
  | "missing_linear_api_key_for_implementation_subject"
  | "planning_only_suppressed";

export interface WebhookAcceptedResponse {
  accepted: true;
  /** False when this delivery is a duplicate of an already-accepted envelope. */
  dispatched: boolean;
  duplicate?: boolean;
  /** Opaque job-request id — never an issue key. */
  requestId: string;
}

export interface WebhookIgnoredResponse {
  accepted: false;
  reason: WebhookIgnoreReason;
}

export interface WebhookErrorResponse {
  error:
    | "method_not_allowed"
    | "invalid_signature"
    | "timestamp_out_of_tolerance"
    | "dispatch_failed";
}

export interface RepositoryDispatchPayload {
  issueKey: string;
  issueId: string | null;
  issueUrl: string | null;
  action: string;
  statusName: string | null;
  previousStatusName: string | null;
  linearDeliveryId: string | null;
  linearWebhookId: string | null;
  receivedAt: string;
  /**
   * Nested so the top-level client_payload stays within GitHub's 10-property limit.
   */
  meta?: {
    triggerKind?: "issue_status" | "comment_create";
    commentId?: string | null;
    pmFeedbackCommentId?: string | null;
    prUrl?: string | null;
    reconcile?: "revision" | "merge" | "workflow" | null;
    phase?: string | null;
  };
}

export interface ProductionPromotedDispatchPayload {
  repo: string;
  productionBranch: string;
  sourceRepo: string;
  after: string;
  ref: string;
  receivedAt: string;
  githubRunId?: string;
  githubDeliveryId?: string;
}

/** Public Auto Runner payload — opaque request id only. */
export interface OpaqueJobDispatchPayload {
  requestId: string;
  envelopeSchemaVersion: number;
  publicEventType: string;
}

export interface DispatchGitHubOptions {
  token: string;
  repository: string;
  eventType: string;
  clientPayload:
    | RepositoryDispatchPayload
    | ProductionPromotedDispatchPayload
    | OpaqueJobDispatchPayload;
  fetchImpl?: typeof fetch;
}
