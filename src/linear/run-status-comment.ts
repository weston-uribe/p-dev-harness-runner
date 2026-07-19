import type { LinearClient } from "@linear/sdk";
import { formatGitHubActionsRunLink, getGitHubActionsRunUrl } from "../github/actions-url.js";
import {
  listIssueComments,
  postIssueComment,
  updateIssueComment,
  type LinearCommentRecord,
} from "./writer.js";

export type RevisionIntent = "pending_pm_feedback" | "ready";

export interface RunStatusCommentBodyInput {
  issueId: string;
  headline: string;
  phase: string;
  githubRunUrl?: string | null;
  updatedAt?: string;
  runId?: string | null;
  deliveryId?: string | null;
  generation: number;
  pmFeedbackCommentId?: string | null;
  revisionIntent?: RevisionIntent | null;
}

export interface UpsertRunStatusCommentResult {
  action: "created" | "updated" | "skipped";
  commentId?: string;
  reason?: string;
}

const GENERATION_METADATA_PATTERN = /^generation:\s*(\d+)\s*$/m;
const RUN_ID_METADATA_PATTERN = /^run_id:\s*(.+)\s*$/m;
const DELIVERY_ID_METADATA_PATTERN = /^delivery_id:\s*(.+)\s*$/m;
const PM_FEEDBACK_METADATA_PATTERN = /^pm_feedback_comment_id:\s*(.+)\s*$/m;
const REVISION_INTENT_METADATA_PATTERN = /^revision_intent:\s*(.+)\s*$/m;

export function buildRunStatusMarker(issueId: string): string {
  return `<!-- p-dev-run-status:${issueId} -->`;
}

export function buildRunStatusCommentBody(input: RunStatusCommentBodyInput): string {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const githubRunUrl = input.githubRunUrl ?? getGitHubActionsRunUrl();
  const runLink = githubRunUrl ? formatGitHubActionsRunLink(githubRunUrl) : null;

  const visibleLines = [
    buildRunStatusMarker(input.issueId),
    `**${input.headline}**`,
    `- Phase: \`${input.phase}\``,
    runLink ? `- Run: ${runLink}` : null,
    `- Last updated: \`${updatedAt}\``,
  ].filter(Boolean);

  const hiddenMetadata = [
    "<!--",
    `generation: ${input.generation}`,
    input.runId ? `run_id: ${input.runId}` : null,
    input.deliveryId ? `delivery_id: ${input.deliveryId}` : null,
    input.pmFeedbackCommentId
      ? `pm_feedback_comment_id: ${input.pmFeedbackCommentId}`
      : null,
    input.revisionIntent ? `revision_intent: ${input.revisionIntent}` : null,
    "-->",
  ]
    .filter(Boolean)
    .join("\n");

  return `${visibleLines.join("\n")}\n\n${hiddenMetadata}`;
}

export function parseRunStatusGeneration(commentBody: string): number | null {
  const match = commentBody.match(GENERATION_METADATA_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function findRunStatusComment(
  comments: LinearCommentRecord[],
  issueId: string,
): LinearCommentRecord | null {
  const marker = buildRunStatusMarker(issueId);
  const matches = comments.filter((comment) => comment.body.includes(marker));
  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => {
    const leftGeneration = parseRunStatusGeneration(left.body) ?? 0;
    const rightGeneration = parseRunStatusGeneration(right.body) ?? 0;
    if (leftGeneration !== rightGeneration) {
      return rightGeneration - leftGeneration;
    }
    return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  })[0] ?? null;
}

export async function upsertRunStatusComment(
  client: LinearClient,
  issueId: string,
  body: string,
  options: { generation: number },
): Promise<UpsertRunStatusCommentResult> {
  const comments = await listIssueComments(client, issueId);
  const existing = findRunStatusComment(comments, issueId);
  if (existing) {
    const existingGeneration = parseRunStatusGeneration(existing.body);
    if (existingGeneration !== null && options.generation < existingGeneration) {
      return {
        action: "skipped",
        commentId: existing.id,
        reason: "incoming generation is older than existing comment",
      };
    }

    await updateIssueComment(client, existing.id, body);
    return { action: "updated", commentId: existing.id };
  }

  const commentId = await postIssueComment(client, issueId, body);
  return { action: "created", commentId };
}

export async function acknowledgeIssueReceived(
  client: LinearClient,
  issueId: string,
  input: {
    runId?: string | null;
    deliveryId?: string | null;
    generation: number;
  },
): Promise<UpsertRunStatusCommentResult> {
  const body = buildRunStatusCommentBody({
    issueId,
    headline: "PDev received this issue",
    phase: "Preparing it for planning",
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
  });
}

export async function updateRunStatusPhase(
  client: LinearClient,
  issueId: string,
  input: {
    phase: string;
    headline?: string;
    runId?: string | null;
    deliveryId?: string | null;
    generation: number;
  },
): Promise<UpsertRunStatusCommentResult> {
  const body = buildRunStatusCommentBody({
    issueId,
    headline: input.headline ?? `Harness run in progress (${input.phase})`,
    phase: input.phase,
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
  });
}

export async function markRunStatusBlocked(
  client: LinearClient,
  issueId: string,
  input: {
    message: string;
    phase?: string;
    runId?: string | null;
    deliveryId?: string | null;
    generation: number;
  },
): Promise<UpsertRunStatusCommentResult> {
  const body = buildRunStatusCommentBody({
    issueId,
    headline: input.message,
    phase: input.phase ?? "Blocked",
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
  });
}

export function parseRunStatusMetadata(commentBody: string): {
  generation: number | null;
  runId: string | null;
  deliveryId: string | null;
  pmFeedbackCommentId: string | null;
  revisionIntent: RevisionIntent | null;
} {
  const intentRaw =
    commentBody.match(REVISION_INTENT_METADATA_PATTERN)?.[1]?.trim() ?? null;
  const revisionIntent: RevisionIntent | null =
    intentRaw === "pending_pm_feedback" || intentRaw === "ready"
      ? intentRaw
      : null;

  return {
    generation: parseRunStatusGeneration(commentBody),
    runId: commentBody.match(RUN_ID_METADATA_PATTERN)?.[1]?.trim() ?? null,
    deliveryId:
      commentBody.match(DELIVERY_ID_METADATA_PATTERN)?.[1]?.trim() ?? null,
    pmFeedbackCommentId:
      commentBody.match(PM_FEEDBACK_METADATA_PATTERN)?.[1]?.trim() ?? null,
    revisionIntent,
  };
}

/** Durable pending revision intent while Needs Revision awaits PM feedback. */
export async function markRevisionPendingPmFeedback(
  client: LinearClient,
  issueId: string,
  input?: {
    runId?: string | null;
    deliveryId?: string | null;
    generation?: number;
  },
): Promise<UpsertRunStatusCommentResult> {
  const generation = input?.generation ?? Date.now();
  const body = buildRunStatusCommentBody({
    issueId,
    headline: "Revision pending — waiting for PM feedback",
    phase: "Needs Revision (awaiting feedback)",
    runId: input?.runId,
    deliveryId: input?.deliveryId,
    generation,
    revisionIntent: "pending_pm_feedback",
  });
  return upsertRunStatusComment(client, issueId, body, { generation });
}
