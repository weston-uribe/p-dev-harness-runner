import { parsePrUrl } from "../github/pr-url.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { findLatestMergeSourceComment } from "../linear/merge-source-comment.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import type { WorkflowStateRecord } from "../workflow/state/types.js";
import type { MergeRequestIdentityInput } from "../workflow/job-request/merge-request-id.js";

export function resolveMergeReconcileIdentity(input: {
  issue: LinearIssueSnapshot;
  comments: LinearCommentRecord[];
  orchestratorMarker: string;
  targetRepository: string;
  authoritativeState?: WorkflowStateRecord | null;
}): MergeRequestIdentityInput | null {
  const mergeSource = findLatestMergeSourceComment(
    input.comments,
    input.orchestratorMarker,
  );
  if (!mergeSource?.markers.prUrl) {
    return null;
  }

  const parsedPr = parsePrUrl(mergeSource.markers.prUrl);
  const decision =
    input.authoritativeState?.lastAcceptedReviewDecision?.decisionIdentity?.trim() ||
    null;
  const reviewedHeadSha =
    input.authoritativeState?.lastAcceptedReviewDecision?.reviewedHeadSha?.trim() ||
    mergeSource.markers.prHeadSha?.trim() ||
    input.authoritativeState?.latestImplementationArtifact?.headSha?.trim() ||
    null;
  const prNumber =
    input.authoritativeState?.lastAcceptedReviewDecision?.reviewedPrNumber ??
    (mergeSource.markers.prNumber
      ? Number(mergeSource.markers.prNumber)
      : null) ??
    parsedPr?.pullNumber ??
    input.authoritativeState?.latestImplementationArtifact?.prNumber ??
    null;

  if (!decision || !reviewedHeadSha || !prNumber || !Number.isFinite(prNumber)) {
    return null;
  }

  return {
    issueKey: input.issue.identifier,
    targetRepository: input.targetRepository,
    prNumber: Number(prNumber),
    reviewedHeadSha,
    approvedReviewDecisionIdentity: decision,
  };
}
