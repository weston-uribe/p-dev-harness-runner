/**
 * Deterministic Code Revision Linear comments / durable revision artifacts.
 */

import {
  formatHarnessCommentFooter,
  type HarnessCommentFooterInput,
} from "./comments.js";
import { parseHarnessMarkers } from "./markers.js";

export interface CodeRevisionFindingResolution {
  findingId: string;
  resolution: string;
  evidence: string;
}

export interface CodeRevisionOutcome {
  summary: string;
  resultState:
    | "verified_complete"
    | "blocked_external"
    | "requires_product_judgment"
    | "verification_failed";
  findingsAddressed: CodeRevisionFindingResolution[];
  filesChanged: string[];
  testEvidence: string;
  currentHeadSha: string;
  currentDiffHash: string;
}

export interface CodeRevisionCommentFooterInput extends HarnessCommentFooterInput {
  revisionIdentity: string;
  causedByReviewDecisionIdentity: string;
  currentHeadSha: string;
  currentDiffHash: string;
  reviewedPrNumber: number;
}

export function formatCodeRevisionComment(input: {
  outcome: CodeRevisionOutcome;
  footer: CodeRevisionCommentFooterInput;
}): string {
  const findingsSection =
    input.outcome.findingsAddressed.length > 0
      ? input.outcome.findingsAddressed
          .map(
            (f) =>
              `- **${f.findingId}**: ${f.resolution}\n  - Evidence: ${f.evidence}`,
          )
          .join("\n")
      : "_None._";

  const filesSection =
    input.outcome.filesChanged.length > 0
      ? input.outcome.filesChanged.map((f) => `- \`${f}\``).join("\n")
      : "_None._";

  const body = [
    "## Code Revision",
    "",
    `**Result:** ${input.outcome.resultState}`,
    "",
    `**Summary:** ${input.outcome.summary}`,
    "",
    "### Findings addressed",
    "",
    findingsSection,
    "",
    "### Files changed",
    "",
    filesSection,
    "",
    "### Test evidence",
    "",
    input.outcome.testEvidence.trim() || "_None reported._",
    "",
    "### Revision identity",
    "",
    `- PR: #${input.footer.reviewedPrNumber}`,
    `- Head SHA: \`${input.footer.currentHeadSha}\``,
    `- Diff hash: \`${input.footer.currentDiffHash}\``,
    `- Caused by review decision: \`${input.footer.causedByReviewDecisionIdentity}\``,
    `- Revision identity: \`${input.footer.revisionIdentity}\``,
  ].join("\n");

  const footer = formatHarnessCommentFooter({
    ...input.footer,
    phase: "code_revision",
  });
  return `${body}\n\n<!--\nrevision_identity: ${input.footer.revisionIdentity}\ncaused_by_review_decision_identity: ${input.footer.causedByReviewDecisionIdentity}\ncurrent_head_sha: ${input.footer.currentHeadSha}\ncurrent_diff_hash: ${input.footer.currentDiffHash}\n-->\n\n${footer}`;
}

export function hasCodeRevisionMarker(
  commentBody: string,
  orchestratorMarker: string,
  revisionIdentity: string,
): boolean {
  const markers = parseHarnessMarkers(commentBody);
  if (
    markers.orchestratorMarker !== orchestratorMarker ||
    markers.phase !== "code_revision"
  ) {
    return false;
  }
  return commentBody.includes(`revision_identity: ${revisionIdentity}`);
}

export function findCodeRevisionCommentByIdentity(
  comments: ReadonlyArray<{ id: string; body: string }>,
  orchestratorMarker: string,
  revisionIdentity: string,
): { id: string; body: string } | null {
  for (const comment of comments) {
    if (
      hasCodeRevisionMarker(comment.body, orchestratorMarker, revisionIdentity)
    ) {
      return comment;
    }
  }
  return null;
}
