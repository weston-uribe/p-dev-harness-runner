import { isDispatchTriggerStatus } from "./dispatch-statuses.js";
import type { HarnessConfig } from "../config/types.js";
import { runLinearAssociationGate } from "../config/linear-association-gate.js";
import { isHarnessOrchestratorComment } from "../linear/comments.js";
import type {
  ParsedLinearCommentWebhook,
  ParsedLinearIssueWebhook,
} from "./types.js";

export type FilterResult =
  | { dispatch: true }
  | {
      dispatch: false;
      reason:
        | "ignored_event"
        | "ignored_status"
        | "linear_team_project_not_configured";
    };

export function shouldDispatchLinearIssueEvent(
  event: ParsedLinearIssueWebhook,
  options?: { config?: HarnessConfig },
): FilterResult {
  if (event.eventType !== "Issue") {
    return { dispatch: false, reason: "ignored_event" };
  }

  if (event.action === "remove") {
    return { dispatch: false, reason: "ignored_event" };
  }

  const passesEventShape = passesStageOneEventShape(event);
  if (!passesEventShape) {
    return { dispatch: false, reason: "ignored_event" };
  }

  if (!isDispatchTriggerStatus(event.statusName)) {
    return { dispatch: false, reason: "ignored_status" };
  }

  if (options?.config) {
    const associationGate = runLinearAssociationGate({
      config: options.config,
      teamId: event.teamId,
      projectId: event.projectId,
    });
    if (!associationGate.ok) {
      return {
        dispatch: false,
        reason: "linear_team_project_not_configured",
      };
    }
  }

  return { dispatch: true };
}

/**
 * Comment create may dispatch for revision reconciliation.
 * Needs Revision / feedback eligibility is evaluated live in resolve-route.
 */
export function shouldDispatchLinearCommentEvent(
  event: ParsedLinearCommentWebhook,
  options?: { config?: HarnessConfig; orchestratorMarker?: string },
): FilterResult {
  if (event.eventType !== "Comment") {
    return { dispatch: false, reason: "ignored_event" };
  }

  if (event.action !== "create") {
    return { dispatch: false, reason: "ignored_event" };
  }

  if (!event.issueKey && !event.issueId) {
    return { dispatch: false, reason: "ignored_event" };
  }

  const marker =
    options?.orchestratorMarker ?? options?.config?.orchestratorMarker;
  if (
    marker &&
    event.commentBody &&
    isHarnessOrchestratorComment(event.commentBody, marker)
  ) {
    return { dispatch: false, reason: "ignored_event" };
  }

  return { dispatch: true };
}

function passesStageOneEventShape(event: ParsedLinearIssueWebhook): boolean {
  if (event.action === "update") {
    return event.statusChanged;
  }

  if (event.action === "create") {
    return isDispatchTriggerStatus(event.statusName);
  }

  return false;
}
