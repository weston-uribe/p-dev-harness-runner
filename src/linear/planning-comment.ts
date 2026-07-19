import { hasPlanningCompletionMarker } from "./comments.js";
import type { LinearCommentRecord } from "./writer.js";

export function findLatestPlanningComment(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
): LinearCommentRecord | null {
  const planningComments = comments.filter((comment) =>
    hasPlanningCompletionMarker(comment.body, orchestratorMarker),
  );

  planningComments.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });

  return planningComments[0] ?? null;
}
