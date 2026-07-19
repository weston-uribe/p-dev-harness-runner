import { LinearClient } from "@linear/sdk";
import type { LinearIssueSnapshot } from "./client.js";
import { resolveWorkflowStateId } from "./states.js";
import {
  formatHarnessCommentFooter,
  formatHandoffComment,
  formatPlanningComment,
  buildErrorCommentBody,
  type HandoffCommentFooterInput,
  type RevisionCommentFooterInput,
  formatRevisionComment,
  type MergeCommentFooterInput,
  formatMergeComment,
  type HarnessCommentFooterInput,
  type ProductionSyncCommentFooterInput,
  formatProductionSyncComment,
  type PhaseStartPhase,
  type PhaseStartCommentBodyInput,
  formatPhaseStartComment,
  findPhaseStartMarker,
} from "./comments.js";
import { getGitHubActionsRunUrl } from "../github/actions-url.js";

export interface LinearCommentRecord {
  id: string;
  body: string;
  createdAt?: string;
}

export async function listIssueComments(
  client: LinearClient,
  issueId: string,
): Promise<LinearCommentRecord[]> {
  const issue = await client.issue(issueId);
  if (!issue) {
    throw new Error(`Linear issue not found: ${issueId}`);
  }
  const connection = await issue.comments();
  return (connection.nodes ?? []).map((comment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt?.toISOString(),
  }));
}

export async function transitionIssueStatus(
  client: LinearClient,
  issue: LinearIssueSnapshot,
  statusName: string,
): Promise<void> {
  if (!issue.teamId) {
    throw new Error(`Issue ${issue.identifier} is missing teamId`);
  }
  const stateId = await resolveWorkflowStateId(
    client,
    issue.teamId,
    statusName,
  );
  const linearIssue = await client.issue(issue.id);
  if (!linearIssue) {
    throw new Error(`Linear issue not found: ${issue.id}`);
  }
  try {
    const payload = await linearIssue.update({ stateId });
    if (!payload.success) {
      throw new Error(`Failed to transition issue to ${statusName}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Failed to transition issue")
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to transition issue to ${statusName}: ${detail}`,
    );
  }
}

export async function postIssueComment(
  client: LinearClient,
  issueId: string,
  body: string,
): Promise<string> {
  const payload = await client.createComment({ issueId, body });
  if (!payload.success) {
    throw new Error("Failed to create Linear comment");
  }
  const comment = await payload.comment;
  return comment?.id ?? "unknown";
}

export async function updateIssueComment(
  client: LinearClient,
  commentId: string,
  body: string,
): Promise<void> {
  const payload = await client.updateComment(commentId, { body });
  if (!payload.success) {
    throw new Error("Failed to update Linear comment");
  }
}

export async function postPlanningComment(
  client: LinearClient,
  issueId: string,
  planBody: string,
  footer: HarnessCommentFooterInput,
): Promise<string> {
  const body = formatPlanningComment(planBody, footer);
  return postIssueComment(client, issueId, body);
}

export async function postHandoffComment(
  client: LinearClient,
  issueId: string,
  summaryBody: string,
  footer: HandoffCommentFooterInput,
): Promise<string> {
  const body = formatHandoffComment(summaryBody, footer);
  return postIssueComment(client, issueId, body);
}

export async function postRevisionComment(
  client: LinearClient,
  issueId: string,
  summaryBody: string,
  footer: RevisionCommentFooterInput,
): Promise<string> {
  const body = formatRevisionComment(summaryBody, footer);
  return postIssueComment(client, issueId, body);
}

export async function postMergeCompletionComment(
  client: LinearClient,
  issueId: string,
  summaryBody: string,
  footer: MergeCommentFooterInput,
): Promise<string> {
  const body = formatMergeComment(summaryBody, footer);
  return postIssueComment(client, issueId, body);
}

export async function postProductionSyncComment(
  client: LinearClient,
  issueId: string,
  summaryBody: string,
  footer: ProductionSyncCommentFooterInput,
): Promise<string> {
  const body = formatProductionSyncComment(summaryBody, footer);
  return postIssueComment(client, issueId, body);
}

export interface PostPhaseStartCommentInput {
  orchestratorMarker: string;
  phase: PhaseStartPhase;
  runId: string;
  issueKey: string;
  targetRepo: string;
  baseBranch?: string;
  model: string;
  promptVersion: string;
  branch?: string;
  prUrl?: string;
  cursorAgentId?: string;
  cursorRunId?: string;
  builderAgentId?: string;
  builderThreadGeneration?: number;
  builderThreadAction?: string;
  builderOriginRunId?: string;
  builderThreadIdempotencyKey?: string;
  previousBuilderAgentId?: string;
  builderThreadReplacementReason?: string;
}

export async function postPhaseStartCommentIfNeeded(
  client: LinearClient,
  issueId: string,
  input: PostPhaseStartCommentInput,
): Promise<string | null> {
  const comments = await listIssueComments(client, issueId);
  if (
    findPhaseStartMarker(
      comments,
      input.orchestratorMarker,
      input.phase,
      input.runId,
    )
  ) {
    return null;
  }

  const githubActionsRunUrl = getGitHubActionsRunUrl();
  const bodyInput: PhaseStartCommentBodyInput = {
    issueKey: input.issueKey,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    branch: input.branch,
    prUrl: input.prUrl,
    githubActionsRunUrl,
    cursorAgentId: input.cursorAgentId,
    cursorRunId: input.cursorRunId,
  };
  const body = formatPhaseStartComment(input.phase, bodyInput, {
    orchestratorMarker: input.orchestratorMarker,
    runId: input.runId,
    cursorAgentId: input.cursorAgentId,
    cursorRunId: input.cursorRunId,
    builderAgentId: input.builderAgentId,
    builderThreadGeneration: input.builderThreadGeneration,
    builderThreadAction: input.builderThreadAction,
    builderOriginRunId: input.builderOriginRunId,
    builderThreadIdempotencyKey: input.builderThreadIdempotencyKey,
    previousBuilderAgentId: input.previousBuilderAgentId,
    builderThreadReplacementReason: input.builderThreadReplacementReason,
    model: input.model,
    promptVersion: input.promptVersion,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    branch: input.branch,
    prUrl: input.prUrl,
    githubActionsRunUrl: githubActionsRunUrl ?? undefined,
  });
  return postIssueComment(client, issueId, body);
}

export async function postErrorComment(
  client: LinearClient,
  issueId: string,
  message: string,
  footer: MergeCommentFooterInput,
  phase: "planning" | "implementation" | "handoff" | "revision" | "merge" | "production_sync" = "planning",
  options?: {
    errorClassification?: string;
  },
): Promise<string> {
  const body = `${buildErrorCommentBody(phase, message, {
    githubActionsRunUrl:
      footer.githubActionsRunUrl ?? getGitHubActionsRunUrl(),
    errorClassification: options?.errorClassification,
    targetRepo: footer.targetRepo,
    branch: footer.branch,
    prUrl: footer.prUrl,
    baseBranch: footer.baseBranch,
    harnessRunId: footer.runId,
  })}\n\n${formatHarnessCommentFooter(footer)}`;
  return postIssueComment(client, issueId, body);
}

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}
