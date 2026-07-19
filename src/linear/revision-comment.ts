import { hasRevisionCompletionMarker } from "./comments.js";
import type { LinearCommentRecord } from "./writer.js";

export function findLatestRevisionComment(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
): LinearCommentRecord | null {
  const revisionComments = comments.filter((comment) =>
    hasRevisionCompletionMarker(comment.body, orchestratorMarker),
  );

  revisionComments.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });

  return revisionComments[0] ?? null;
}
