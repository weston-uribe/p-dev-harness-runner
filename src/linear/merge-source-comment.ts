import { hasHandoffCompletionMarker } from "./comments.js";
import { findLatestRevisionComment } from "./revision-comment.js";
import { parseHarnessMarkers, type HarnessMarkers } from "./markers.js";
import type { LinearCommentRecord } from "./writer.js";

export type MergeSourceKind = "revision" | "handoff";

export interface MergeSourceComment {
  source: MergeSourceKind;
  comment: LinearCommentRecord;
  markers: HarnessMarkers;
}

export function findLatestMergeSourceComment(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
): MergeSourceComment | null {
  const revisionComment = findLatestRevisionComment(comments, orchestratorMarker);
  if (revisionComment) {
    return {
      source: "revision",
      comment: revisionComment,
      markers: parseHarnessMarkers(revisionComment.body),
    };
  }

  const handoffComments = comments.filter((comment) =>
    hasHandoffCompletionMarker(comment.body, orchestratorMarker),
  );
  handoffComments.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });

  const handoffComment = handoffComments[0];
  if (!handoffComment) {
    return null;
  }

  return {
    source: "handoff",
    comment: handoffComment,
    markers: parseHarnessMarkers(handoffComment.body),
  };
}
