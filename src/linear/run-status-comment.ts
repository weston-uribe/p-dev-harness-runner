import type { LinearClient } from "@linear/sdk";
import { formatGitHubActionsRunLink, getGitHubActionsRunUrl } from "../github/actions-url.js";
import {
  listIssueComments,
  postIssueComment,
  updateIssueComment,
  type LinearCommentRecord,
} from "./writer.js";

export type RevisionIntent = "pending_pm_feedback" | "ready";

export type RunStatusOutcomeClass =
  | "accepted"
  | "in_progress"
  | "success"
  | "duplicate"
  | "failed"
  | "blocked";

export interface RunStatusAuthority {
  /** Workflow state revision at write time (0 when not yet bootstrapped). */
  stateRevision: number;
  phase: string;
  outcomeClass: RunStatusOutcomeClass;
  reviewSubjectIdentity?: string | null;
  ownedActiveClaim: boolean;
}

export interface RunStatusCommentBodyInput extends RunStatusAuthority {
  issueId: string;
  headline: string;
  /** Optional user-visible phase label; defaults to authority phase. */
  visiblePhase?: string;
  githubRunUrl?: string | null;
  updatedAt?: string;
  runId?: string | null;
  deliveryId?: string | null;
  /** Legacy numeric generation retained for backward-compatible parsers. */
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
const STATE_REVISION_METADATA_PATTERN = /^state_revision:\s*(\d+)\s*$/m;
const OUTCOME_CLASS_METADATA_PATTERN = /^outcome_class:\s*(.+)\s*$/m;
const SUBJECT_IDENTITY_METADATA_PATTERN = /^review_subject_identity:\s*(.+)\s*$/m;
const OWNED_CLAIM_METADATA_PATTERN = /^owned_active_claim:\s*(true|false)\s*$/m;
const PHASE_METADATA_PATTERN = /^authority_phase:\s*(.+)\s*$/m;

const OUTCOME_RANK: Record<RunStatusOutcomeClass, number> = {
  accepted: 10,
  in_progress: 20,
  duplicate: 25,
  success: 40,
  failed: 30,
  blocked: 35,
};

export function buildRunStatusMarker(issueId: string): string {
  return `<!-- p-dev-run-status:${issueId} -->`;
}

export function buildRunStatusCommentBody(input: RunStatusCommentBodyInput): string {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const githubRunUrl = input.githubRunUrl ?? getGitHubActionsRunUrl();
  const runLink = githubRunUrl ? formatGitHubActionsRunLink(githubRunUrl) : null;

  const visiblePhase = input.visiblePhase ?? input.phase;
  const visibleLines = [
    buildRunStatusMarker(input.issueId),
    `**${input.headline}**`,
    `- Phase: \`${visiblePhase}\``,
    runLink ? `- Run: ${runLink}` : null,
    `- Last updated: \`${updatedAt}\``,
  ].filter(Boolean);

  const hiddenMetadata = [
    "<!--",
    `generation: ${input.generation}`,
    `state_revision: ${input.stateRevision}`,
    `authority_phase: ${input.phase}`,
    `outcome_class: ${input.outcomeClass}`,
    `owned_active_claim: ${input.ownedActiveClaim ? "true" : "false"}`,
    input.reviewSubjectIdentity
      ? `review_subject_identity: ${input.reviewSubjectIdentity}`
      : null,
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

export function parseRunStatusAuthority(commentBody: string): RunStatusAuthority | null {
  const stateRevisionRaw = commentBody.match(STATE_REVISION_METADATA_PATTERN)?.[1];
  const outcomeRaw = commentBody.match(OUTCOME_CLASS_METADATA_PATTERN)?.[1]?.trim();
  const phase =
    commentBody.match(PHASE_METADATA_PATTERN)?.[1]?.trim() ||
    commentBody.match(/^- Phase: `([^`]+)`/m)?.[1]?.trim() ||
    null;
  if (!stateRevisionRaw || !outcomeRaw || !phase) {
    return null;
  }
  const stateRevision = Number(stateRevisionRaw);
  if (!Number.isFinite(stateRevision)) {
    return null;
  }
  if (!(outcomeRaw in OUTCOME_RANK)) {
    return null;
  }
  return {
    stateRevision,
    phase,
    outcomeClass: outcomeRaw as RunStatusOutcomeClass,
    reviewSubjectIdentity:
      commentBody.match(SUBJECT_IDENTITY_METADATA_PATTERN)?.[1]?.trim() ?? null,
    ownedActiveClaim:
      commentBody.match(OWNED_CLAIM_METADATA_PATTERN)?.[1] === "true",
  };
}

/**
 * Causal compare-before-write: later workflow revision wins; within the same
 * revision, higher outcome rank wins; non-owners cannot publish authoritative failures.
 */
export function shouldAcceptRunStatusUpdate(input: {
  existing: RunStatusAuthority | null;
  incoming: RunStatusAuthority;
}): { accept: boolean; reason?: string } {
  const { existing, incoming } = input;
  if (!existing) {
    return { accept: true };
  }

  if (incoming.stateRevision < existing.stateRevision) {
    return { accept: false, reason: "stale_workflow_revision" };
  }

  if (incoming.stateRevision > existing.stateRevision) {
    return { accept: true };
  }

  // Same revision: duplicate/no-op must never escalate to blocked/failed.
  if (
    existing.outcomeClass === "success" &&
    (incoming.outcomeClass === "failed" || incoming.outcomeClass === "blocked")
  ) {
    return { accept: false, reason: "success_dominates_failure" };
  }

  if (
    existing.outcomeClass === "accepted" &&
    (incoming.outcomeClass === "failed" || incoming.outcomeClass === "blocked") &&
    !incoming.ownedActiveClaim
  ) {
    return { accept: false, reason: "non_owner_cannot_block_acceptance" };
  }

  if (
    (incoming.outcomeClass === "failed" || incoming.outcomeClass === "blocked") &&
    !incoming.ownedActiveClaim
  ) {
    return { accept: false, reason: "non_owner_cannot_publish_phase_failure" };
  }

  if (incoming.outcomeClass === "duplicate") {
    if (
      existing.outcomeClass === "success" ||
      existing.outcomeClass === "accepted" ||
      existing.outcomeClass === "in_progress"
    ) {
      return { accept: false, reason: "duplicate_cannot_overwrite_progress" };
    }
  }

  const existingRank = OUTCOME_RANK[existing.outcomeClass] ?? 0;
  const incomingRank = OUTCOME_RANK[incoming.outcomeClass] ?? 0;
  if (incomingRank < existingRank) {
    return { accept: false, reason: "lower_outcome_rank" };
  }

  return { accept: true };
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
    const leftAuth = parseRunStatusAuthority(left.body);
    const rightAuth = parseRunStatusAuthority(right.body);
    if (leftAuth && rightAuth) {
      if (leftAuth.stateRevision !== rightAuth.stateRevision) {
        return rightAuth.stateRevision - leftAuth.stateRevision;
      }
      const leftRank = OUTCOME_RANK[leftAuth.outcomeClass] ?? 0;
      const rightRank = OUTCOME_RANK[rightAuth.outcomeClass] ?? 0;
      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }
    }
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
  options: { generation: number; authority?: RunStatusAuthority },
): Promise<UpsertRunStatusCommentResult> {
  const comments = await listIssueComments(client, issueId);
  const existing = findRunStatusComment(comments, issueId);
  if (existing) {
    const incomingAuthority =
      options.authority ?? parseRunStatusAuthority(body);
    const existingAuthority = parseRunStatusAuthority(existing.body);

    if (incomingAuthority) {
      const decision = shouldAcceptRunStatusUpdate({
        existing: existingAuthority,
        incoming: incomingAuthority,
      });
      if (!decision.accept) {
        return {
          action: "skipped",
          commentId: existing.id,
          reason: decision.reason,
        };
      }
    } else {
      // Legacy body without authority: fall back to generation monotonicity.
      const existingGeneration = parseRunStatusGeneration(existing.body);
      if (existingGeneration !== null && options.generation < existingGeneration) {
        return {
          action: "skipped",
          commentId: existing.id,
          reason: "incoming generation is older than existing comment",
        };
      }
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
    stateRevision?: number;
    phase?: string;
    outcomeClass?: RunStatusOutcomeClass;
    ownedActiveClaim?: boolean;
    reviewSubjectIdentity?: string | null;
  },
): Promise<UpsertRunStatusCommentResult> {
  const authority: RunStatusAuthority = {
    stateRevision: input.stateRevision ?? 0,
    phase: input.phase ?? "accepted",
    outcomeClass: input.outcomeClass ?? "accepted",
    reviewSubjectIdentity: input.reviewSubjectIdentity ?? null,
    ownedActiveClaim: input.ownedActiveClaim ?? true,
  };
  const body = buildRunStatusCommentBody({
    issueId,
    headline: "PDev accepted this issue",
    visiblePhase: "Preparing the next phase",
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
    ...authority,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
    authority,
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
    stateRevision?: number;
    outcomeClass?: RunStatusOutcomeClass;
    ownedActiveClaim?: boolean;
    reviewSubjectIdentity?: string | null;
  },
): Promise<UpsertRunStatusCommentResult> {
  const authority: RunStatusAuthority = {
    stateRevision: input.stateRevision ?? 0,
    phase: input.phase,
    outcomeClass: input.outcomeClass ?? "in_progress",
    reviewSubjectIdentity: input.reviewSubjectIdentity ?? null,
    ownedActiveClaim: input.ownedActiveClaim ?? true,
  };
  const body = buildRunStatusCommentBody({
    issueId,
    headline: input.headline ?? `Harness run in progress (${input.phase})`,
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
    ...authority,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
    authority,
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
    stateRevision?: number;
    ownedActiveClaim?: boolean;
    reviewSubjectIdentity?: string | null;
  },
): Promise<UpsertRunStatusCommentResult> {
  const authority: RunStatusAuthority = {
    stateRevision: input.stateRevision ?? 0,
    phase: input.phase ?? "Blocked",
    outcomeClass: "blocked",
    reviewSubjectIdentity: input.reviewSubjectIdentity ?? null,
    ownedActiveClaim: input.ownedActiveClaim ?? false,
  };
  const body = buildRunStatusCommentBody({
    issueId,
    headline: input.message,
    runId: input.runId,
    deliveryId: input.deliveryId,
    generation: input.generation,
    ...authority,
  });
  return upsertRunStatusComment(client, issueId, body, {
    generation: input.generation,
    authority,
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
    stateRevision?: number;
  },
): Promise<UpsertRunStatusCommentResult> {
  const generation = input?.generation ?? Date.now();
  const authority: RunStatusAuthority = {
    stateRevision: input?.stateRevision ?? 0,
    phase: "Needs Revision (awaiting feedback)",
    outcomeClass: "in_progress",
    ownedActiveClaim: true,
  };
  const body = buildRunStatusCommentBody({
    issueId,
    headline: "Revision pending — waiting for PM feedback",
    runId: input?.runId,
    deliveryId: input?.deliveryId,
    generation,
    revisionIntent: "pending_pm_feedback",
    ...authority,
  });
  return upsertRunStatusComment(client, issueId, body, { generation, authority });
}
