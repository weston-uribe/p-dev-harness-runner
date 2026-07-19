import { isHarnessOrchestratorComment } from "./comments.js";
import type { LinearCommentRecord } from "./writer.js";

export function findLatestPmFeedbackAfterHandoff(
  comments: LinearCommentRecord[],
  handoffComment: LinearCommentRecord,
  orchestratorMarker: string,
): LinearCommentRecord | null {
  const handoffTime = handoffComment.createdAt
    ? Date.parse(handoffComment.createdAt)
    : 0;

  const candidates = comments.filter((comment) => {
    if (comment.id === handoffComment.id) {
      return false;
    }

    const commentTime = comment.createdAt ? Date.parse(comment.createdAt) : 0;
    if (handoffTime > 0 && commentTime > 0 && commentTime <= handoffTime) {
      return false;
    }

    if (!comment.body.trim()) {
      return false;
    }

    if (isHarnessOrchestratorComment(comment.body, orchestratorMarker)) {
      return false;
    }

    return true;
  });

  candidates.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });

  return candidates[0] ?? null;
}
