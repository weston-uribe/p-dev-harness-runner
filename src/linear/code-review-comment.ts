/**
 * Deterministic Code Review Linear comments / durable review artifacts.
 */

import type { CodeReviewOutcome } from "../workflow/review-contracts.js";
import {
  formatHarnessCommentFooter,
  type HarnessCommentFooterInput,
} from "./comments.js";
import { parseHarnessMarkers } from "./markers.js";

export interface CodeReviewCommentFooterInput extends HarnessCommentFooterInput {
  decisionIdentity: string;
  reviewedPrNumber: number;
  reviewedHeadSha: string;
  reviewedDiffHash: string;
  codeReviewCycle: number;
  codeReviewCycleLimit: number;
}

export function formatCodeReviewComment(input: {
  outcome: CodeReviewOutcome;
  footer: CodeReviewCommentFooterInput;
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
              `- **${f.id}** (${f.category})${
                f.file ? ` — \`${f.file}\`${f.line ? `:${f.line}` : ""}` : ""
              }: ${f.evidence}${
                f.requiredChange ? `\n  - Required change: ${f.requiredChange}` : ""
              }`,
          )
          .join("\n")
      : "_None._";

  const notesSection =
    nonBlocking.length > 0
      ? nonBlocking
          .map(
            (f) =>
              `- **${f.id}** (${f.category})${
                f.file ? ` — \`${f.file}\`${f.line ? `:${f.line}` : ""}` : ""
              }: ${f.evidence}`,
          )
          .join("\n")
      : "_None._";

  const body = [
    "## Code Review",
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
    `- Cycle: ${input.footer.codeReviewCycle} / ${input.footer.codeReviewCycleLimit}`,
    `- Reviewed PR: #${input.footer.reviewedPrNumber}`,
    `- Reviewed head SHA: \`${input.footer.reviewedHeadSha}\``,
    `- Reviewed diff hash: \`${input.footer.reviewedDiffHash}\``,
    `- Decision identity: \`${input.footer.decisionIdentity}\``,
  ].join("\n");

  const footer = formatHarnessCommentFooter({
    ...input.footer,
    phase: "code_review",
  });
  return `${body}\n\n<!--\ndecision_identity: ${input.footer.decisionIdentity}\nreviewed_pr_number: ${input.footer.reviewedPrNumber}\nreviewed_head_sha: ${input.footer.reviewedHeadSha}\nreviewed_diff_hash: ${input.footer.reviewedDiffHash}\n-->\n\n${footer}`;
}

export function hasCodeReviewDecisionMarker(
  commentBody: string,
  orchestratorMarker: string,
  decisionIdentity: string,
): boolean {
  const markers = parseHarnessMarkers(commentBody);
  if (
    markers.orchestratorMarker !== orchestratorMarker ||
    markers.phase !== "code_review"
  ) {
    return false;
  }
  return commentBody.includes(`decision_identity: ${decisionIdentity}`);
}

export function findCodeReviewCommentByDecision(
  comments: ReadonlyArray<{ id: string; body: string }>,
  orchestratorMarker: string,
  decisionIdentity: string,
): { id: string; body: string } | null {
  for (const comment of comments) {
    if (
      hasCodeReviewDecisionMarker(
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
