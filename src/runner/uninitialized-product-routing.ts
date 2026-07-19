import { LinearClient } from "@linear/sdk";
import { getEligiblePlanningStatuses } from "../config/status-names.js";
import type { HarnessConfig } from "../config/types.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { parseHarnessMarkers } from "../linear/markers.js";
import {
  createLinearClient,
  listIssueComments,
  postIssueComment,
  transitionIssueStatus,
} from "../linear/writer.js";
import type { ResolvedProductInitialization } from "../product/initialization-state.js";

export const UNINITIALIZED_PRODUCT_REROUTE_PHASE = "uninitialized_product_reroute";
export const UNINITIALIZED_PRODUCT_REROUTE_RUN_ID = "product-initialization-policy";

export interface UninitializedProductRoutingInput {
  config: HarnessConfig;
  issue: LinearIssueSnapshot;
  productInitialization: ResolvedProductInitialization;
  linearApiKey: string;
  linearClient?: LinearClient;
}

export interface UninitializedProductRoutingResult {
  rerouted: boolean;
  skippedReason?: string;
  commentId?: string;
  planningStatus?: string;
}

function hasUninitializedRerouteComment(
  comments: { body: string }[],
  orchestratorMarker: string,
): boolean {
  return comments.some((comment) => {
    const markers = parseHarnessMarkers(comment.body);
    return (
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === UNINITIALIZED_PRODUCT_REROUTE_PHASE &&
      markers.runId === UNINITIALIZED_PRODUCT_REROUTE_RUN_ID
    );
  });
}

function buildUninitializedRerouteComment(input: {
  issueKey: string;
  orchestratorMarker: string;
  targetRepo: string;
}): string {
  return [
    "Harness rerouted this issue from **Ready for Build** to **Ready for Planning** because the target product is still uninitialized.",
    "",
    "Complete product foundation planning first. Direct implementation is blocked until `.p-dev/product.json` on the development branch reports `initialized`.",
    "",
    `Issue: ${input.issueKey}`,
    `Target repo: ${input.targetRepo}`,
    "",
    "<!--",
    input.orchestratorMarker,
    `phase: ${UNINITIALIZED_PRODUCT_REROUTE_PHASE}`,
    `run_id: ${UNINITIALIZED_PRODUCT_REROUTE_RUN_ID}`,
    `issue_key: ${input.issueKey}`,
    `target_repo: ${input.targetRepo}`,
    "-->",
  ].join("\n");
}

export function shouldRerouteUninitializedProductToPlanning(
  issueStatus: string | null | undefined,
  config: HarnessConfig,
  productInitialization: ResolvedProductInitialization,
): boolean {
  if (productInitialization.state !== "uninitialized") {
    return false;
  }

  const readyForBuild = config.linear?.transitionalStatuses?.readyForBuild ?? "Ready for Build";
  return issueStatus?.trim().toLowerCase() === readyForBuild.toLowerCase();
}

export async function rerouteUninitializedProductToPlanning(
  input: UninitializedProductRoutingInput & { targetRepo: string },
): Promise<UninitializedProductRoutingResult> {
  if (!shouldRerouteUninitializedProductToPlanning(
    input.issue.status,
    input.config,
    input.productInitialization,
  )) {
    return {
      rerouted: false,
      skippedReason: "reroute_not_applicable",
    };
  }

  const client = input.linearClient ?? createLinearClient(input.linearApiKey);
  const comments = await listIssueComments(client, input.issue.id);
  if (hasUninitializedRerouteComment(comments, input.config.orchestratorMarker)) {
    const planningStatus = getEligiblePlanningStatuses(input.config)[0] ?? "Ready for Planning";
    return {
      rerouted: false,
      skippedReason: "duplicate_reroute_comment",
      planningStatus,
    };
  }

  const planningStatus = getEligiblePlanningStatuses(input.config)[0] ?? "Ready for Planning";
  const commentBody = buildUninitializedRerouteComment({
    issueKey: input.issue.identifier,
    orchestratorMarker: input.config.orchestratorMarker,
    targetRepo: input.targetRepo,
  });
  const commentId = await postIssueComment(client, input.issue.id, commentBody);
  await transitionIssueStatus(client, input.issue, planningStatus);

  return {
    rerouted: true,
    commentId,
    planningStatus,
  };
}
