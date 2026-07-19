import { hasHandoffCompletionMarker } from "./comments.js";
import type { LinearCommentRecord } from "./writer.js";

export function findLatestHandoffComment(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
): LinearCommentRecord | null {
  const handoffComments = comments.filter((comment) =>
    hasHandoffCompletionMarker(comment.body, orchestratorMarker),
  );

  handoffComments.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });

  return handoffComments[0] ?? null;
}
