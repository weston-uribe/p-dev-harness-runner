import { extractIssueKey, extractIssueKeyFromUrl } from "./extract-issue-key.js";
import type { LinearWebhookHeaders, ParsedLinearCommentWebhook } from "./types.js";

interface LinearCommentData {
  id?: string;
  body?: string | null;
  issueId?: string | null;
  issue?: {
    id?: string | null;
    identifier?: string | null;
    url?: string | null;
  } | null;
}

interface LinearCommentWebhookPayload {
  action?: string;
  type?: string;
  url?: string;
  webhookId?: string;
  data?: LinearCommentData;
  actor?: {
    name?: string;
    type?: string;
  };
}

export function parseLinearCommentEvent(
  payload: unknown,
  headers: LinearWebhookHeaders,
  teamKey?: string | null,
): ParsedLinearCommentWebhook | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const body = payload as LinearCommentWebhookPayload;
  const eventType = headers.eventType ?? body.type ?? "";
  if (eventType !== "Comment" && body.type !== "Comment") {
    return null;
  }

  const data = body.data ?? {};
  const issueUrl = data.issue?.url ?? body.url ?? null;
  const issueKey = extractIssueKey({
    identifier: data.issue?.identifier ?? null,
    issueUrl: data.issue?.url ?? null,
    payloadUrl: issueUrl,
    teamKey,
  });

  // Fall back to URL segment when nested issue.identifier is absent.
  const issueKeyFromUrl =
    issueKey ??
    (teamKey
      ? extractIssueKey({
          identifier: extractIssueKeyFromUrl(body.url),
          payloadUrl: body.url,
          teamKey,
        })
      : extractIssueKeyFromUrl(body.url));

  const actorName =
    typeof body.actor?.name === "string" ? body.actor.name.trim() : null;
  const actorType =
    typeof body.actor?.type === "string" ? body.actor.type.trim() : null;

  return {
    issueKey: issueKey ?? issueKeyFromUrl,
    issueId:
      (typeof data.issue?.id === "string" ? data.issue.id : null) ??
      (typeof data.issueId === "string" ? data.issueId : null),
    commentId: typeof data.id === "string" ? data.id : null,
    commentBody: typeof data.body === "string" ? data.body : null,
    action: typeof body.action === "string" ? body.action : "",
    eventType: "Comment",
    linearDeliveryId: headers.deliveryId,
    linearWebhookId:
      typeof body.webhookId === "string" ? body.webhookId : null,
    actorSummary: actorName ?? actorType,
  };
}
