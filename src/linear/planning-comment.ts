import { hasPlanningCompletionMarker } from "./comments.js";
import { parseHarnessMarkers } from "./markers.js";
import type { LinearCommentRecord } from "./writer.js";

export type PlanningContextResolveReason =
  | "present"
  | "absent"
  | "malformed"
  | "superseded";

export interface OptionalPlanningContext {
  commentId: string;
  body: string;
}

export interface ResolveOptionalPlanningContextResult {
  context: OptionalPlanningContext | null;
  reason: PlanningContextResolveReason;
}

function looksLikePlanningAttempt(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = parseHarnessMarkers(commentBody);
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "planning"
  );
}

/**
 * Fail-open selection of optional supplemental planning context.
 * Malformed or superseded planning comments are ignored; absence never throws.
 */
export function resolveOptionalPlanningContext(input: {
  comments: LinearCommentRecord[];
  orchestratorMarker: string;
  supersededGenerationIds?: readonly string[];
}): ResolveOptionalPlanningContextResult {
  const superseded = new Set(
    (input.supersededGenerationIds ?? []).map((id) => id.trim()).filter(Boolean),
  );

  let sawMalformed = false;
  let sawSuperseded = false;
  const valid: LinearCommentRecord[] = [];

  for (const comment of input.comments) {
    if (!looksLikePlanningAttempt(comment.body, input.orchestratorMarker)) {
      continue;
    }
    if (!hasPlanningCompletionMarker(comment.body, input.orchestratorMarker)) {
      sawMalformed = true;
      continue;
    }
    const markers = parseHarnessMarkers(comment.body);
    const generationId = markers.planGenerationId?.trim();
    if (generationId && superseded.has(generationId)) {
      sawSuperseded = true;
      continue;
    }
    valid.push(comment);
  }

  valid.sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return rightTime - leftTime;
  });

  const latest = valid[0];
  if (latest) {
    return {
      context: { commentId: latest.id, body: latest.body },
      reason: "present",
    };
  }
  if (sawSuperseded) {
    return { context: null, reason: "superseded" };
  }
  if (sawMalformed) {
    return { context: null, reason: "malformed" };
  }
  return { context: null, reason: "absent" };
}

/** Newest valid planning completion comment, or null (fail-open). */
export function findLatestPlanningComment(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
  options?: { supersededGenerationIds?: readonly string[] },
): LinearCommentRecord | null {
  const resolved = resolveOptionalPlanningContext({
    comments,
    orchestratorMarker,
    supersededGenerationIds: options?.supersededGenerationIds,
  });
  if (!resolved.context) {
    return null;
  }
  return (
    comments.find((comment) => comment.id === resolved.context?.commentId) ??
    null
  );
}
