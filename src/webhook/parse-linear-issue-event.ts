import { extractIssueKey } from "./extract-issue-key.js";
import type { LinearWebhookHeaders, ParsedLinearIssueWebhook } from "./types.js";

interface LinearStateLike {
  name?: string | null;
}

interface LinearIssueData {
  id?: string;
  identifier?: string;
  url?: string;
  state?: LinearStateLike | null;
  team?: { id?: string | null } | null;
  project?: { id?: string | null } | null;
}

interface LinearWebhookPayload {
  action?: string;
  type?: string;
  url?: string;
  webhookId?: string;
  webhookTimestamp?: number;
  actor?: {
    name?: string;
    type?: string;
  };
  data?: LinearIssueData;
  updatedFrom?: {
    stateId?: string | null;
    state?: LinearStateLike | null;
  };
}

function readStateName(state: LinearStateLike | null | undefined): string | null {
  if (!state || typeof state.name !== "string") {
    return null;
  }
  const trimmed = state.name.trim();
  return trimmed === "" ? null : trimmed;
}

export function hasStatusChange(payload: LinearWebhookPayload): boolean {
  const updatedFrom = payload.updatedFrom;
  if (!updatedFrom) {
    return false;
  }
  if (updatedFrom.stateId != null) {
    return true;
  }
  return updatedFrom.state != null;
}

export function parseLinearIssueEvent(
  payload: unknown,
  headers: LinearWebhookHeaders,
  teamKey?: string | null,
): ParsedLinearIssueWebhook | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const body = payload as LinearWebhookPayload;
  const eventType = headers.eventType ?? body.type ?? "";
  const data = body.data ?? {};
  const statusName = readStateName(data.state);
  const previousStatusName = readStateName(body.updatedFrom?.state);
  const issueUrl = body.url ?? data.url ?? null;

  const issueKey = extractIssueKey({
    identifier: data.identifier ?? null,
    issueUrl: data.url ?? null,
    payloadUrl: issueUrl,
    teamKey,
  });

  const actorName =
    typeof body.actor?.name === "string" ? body.actor.name.trim() : null;
  const actorType =
    typeof body.actor?.type === "string" ? body.actor.type.trim() : null;
  const actorSummary = actorName ?? actorType;

  return {
    issueKey,
    issueId: typeof data.id === "string" ? data.id : null,
    issueUrl,
    teamId: typeof data.team?.id === "string" ? data.team.id : null,
    projectId: typeof data.project?.id === "string" ? data.project.id : null,
    action: typeof body.action === "string" ? body.action : "",
    statusName,
    previousStatusName,
    statusChanged: hasStatusChange(body),
    linearDeliveryId: headers.deliveryId,
    linearWebhookId:
      typeof body.webhookId === "string" ? body.webhookId : null,
    actorSummary,
    eventType,
  };
}

export function readWebhookHeaders(
  headerGetter: (name: string) => string | null,
): LinearWebhookHeaders {
  return {
    signature: headerGetter("linear-signature"),
    deliveryId: headerGetter("linear-delivery"),
    eventType: headerGetter("linear-event"),
    timestamp: headerGetter("linear-timestamp"),
  };
}
