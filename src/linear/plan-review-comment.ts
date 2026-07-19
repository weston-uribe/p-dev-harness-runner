/**
 * Deterministic Plan Review Linear comments / durable review artifacts.
 */

import type { PlanReviewOutcome } from "../workflow/review-contracts.js";
import {
  formatHarnessCommentFooter,
  type HarnessCommentFooterInput,
} from "./comments.js";
import { parseHarnessMarkers } from "./markers.js";

export interface PlanReviewCommentFooterInput extends HarnessCommentFooterInput {
  decisionIdentity: string;
  reviewedPlanGenerationId: string;
  reviewedPlanArtifactHash: string;
  planReviewCycle: number;
  planReviewCycleLimit: number;
}

export function formatPlanReviewComment(input: {
  outcome: PlanReviewOutcome;
  footer: PlanReviewCommentFooterInput;
}): string {
  const blocking = input.outcome.findings.filter(
    (f) => f.severity === "blocking",
  );
  const nonBlocking = input.outcome.findings.filter(
    (f) => f.severity === "non_blocking",
  );

  const blockingSection =
    blocking.length > 0
      ? blocking
          .map(
            (f) =>
              `- **${f.id}** (${f.category}): ${f.evidence}${
                f.requiredChange ? `\n  - Required change: ${f.requiredChange}` : ""
              }`,
          )
          .join("\n")
      : "_None._";

  const notesSection =
    nonBlocking.length > 0
      ? nonBlocking
          .map((f) => `- **${f.id}** (${f.category}): ${f.evidence}`)
          .join("\n")
      : "_None._";

  const body = [
    "## Plan Review",
    "",
    `**Decision:** ${input.outcome.decision}`,
    "",
    `**Summary:** ${input.outcome.summary}`,
    "",
    "### Blocking findings",
    "",
    blockingSection,
    "",
    "### Nonblocking notes",
    "",
    notesSection,
    "",
    "### Review identity",
    "",
    `- Cycle: ${input.footer.planReviewCycle} / ${input.footer.planReviewCycleLimit}`,
    `- Reviewed plan generation: \`${input.footer.reviewedPlanGenerationId}\``,
    `- Reviewed plan hash: \`${input.footer.reviewedPlanArtifactHash}\``,
    `- Decision identity: \`${input.footer.decisionIdentity}\``,
  ].join("\n");

  const footer = formatHarnessCommentFooter({
    ...input.footer,
    phase: "plan_review",
  });
  // Append durable decision identity for idempotent duplicate detection.
  return `${body}\n\n<!--\ndecision_identity: ${input.footer.decisionIdentity}\nreviewed_plan_generation_id: ${input.footer.reviewedPlanGenerationId}\n-->\n\n${footer}`;
}

export function hasPlanReviewDecisionMarker(
  commentBody: string,
  orchestratorMarker: string,
  decisionIdentity: string,
): boolean {
  const markers = parseHarnessMarkers(commentBody);
  if (
    markers.orchestratorMarker !== orchestratorMarker ||
    markers.phase !== "plan_review"
  ) {
    return false;
  }
  return commentBody.includes(`decision_identity: ${decisionIdentity}`);
}

export function findPlanReviewCommentByDecision(
  comments: ReadonlyArray<{ id: string; body: string }>,
  orchestratorMarker: string,
  decisionIdentity: string,
): { id: string; body: string } | null {
  for (const comment of comments) {
    if (
      hasPlanReviewDecisionMarker(
        comment.body,
        orchestratorMarker,
        decisionIdentity,
      )
    ) {
      return comment;
    }
  }
  return null;
}
