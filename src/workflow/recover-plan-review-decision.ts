/**
 * Recover Plan Review needs_revision decision context from durable Linear
 * comments when issue-scoped workflow-state.json is absent (ephemeral GHA).
 */

import { parseHarnessMarkers } from "../linear/markers.js";
import type { ReviewFinding } from "./review-contracts.js";

export interface LinearCommentLike {
  body: string;
  createdAt?: string;
}

export interface RecoveredPlanReviewRevision {
  decisionIdentity: string;
  reviewedPlanGenerationId: string | null;
  summary: string;
  findings: ReviewFinding[];
  planReviewCycle: number;
}

function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(
    `### ${heading}\\n([\\s\\S]*?)(?:\\n### |\\n<!--|\\n---\\n|$)`,
  );
  return body.match(pattern)?.[1]?.trim() ?? "";
}

function parseFindings(section: string, severity: "blocking" | "non_blocking"): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = section.split("\n");
  let current: ReviewFinding | null = null;
  for (const line of lines) {
    const main = line.match(
      /^- \*\*([^*]+)\*\* \(([^)]+)\):\s*(.+)$/,
    );
    if (main) {
      if (current) findings.push(current);
      current = {
        id: main[1]!.trim(),
        severity,
        category: main[2]!.trim(),
        evidence: main[3]!.trim(),
      };
      continue;
    }
    const required = line.match(/^\s*- Required change:\s*(.+)$/);
    if (required && current) {
      current.requiredChange = required[1]!.trim();
    }
  }
  if (current) findings.push(current);
  return findings;
}

/**
 * Newest Plan Review comment with Decision: needs_revision.
 */
export function recoverPlanReviewRevisionFromComments(input: {
  comments: readonly LinearCommentLike[];
  orchestratorMarker: string;
}): RecoveredPlanReviewRevision | null {
  const candidates = input.comments
    .map((c, index) => ({
      body: c.body,
      markers: parseHarnessMarkers(c.body),
      createdAt: c.createdAt,
      index,
    }))
    .filter(
      (c) =>
        c.markers.orchestratorMarker === input.orchestratorMarker &&
        c.markers.phase === "plan_review" &&
        /\*\*Decision:\*\*\s*needs_revision/i.test(c.body),
    )
    .sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return a.index - b.index;
    });

  const latest = candidates[0];
  if (!latest) return null;

  const decisionIdentity =
    latest.body.match(/decision_identity:\s*(\S+)/)?.[1] ??
    latest.body.match(/Decision identity:\s*`([^`]+)`/)?.[1] ??
    null;
  if (!decisionIdentity) return null;

  const reviewedPlanGenerationId =
    latest.body.match(/reviewed_plan_generation_id:\s*(\S+)/)?.[1] ??
    latest.body.match(/Reviewed plan generation:\s*`([^`]+)`/)?.[1] ??
    null;

  const summary =
    latest.body.match(/\*\*Summary:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
  const cycleMatch = latest.body.match(/Cycle:\s*(\d+)\s*\/\s*(\d+)/);
  const planReviewCycle = cycleMatch ? Number(cycleMatch[1]) : 1;

  const findings = [
    ...parseFindings(extractSection(latest.body, "Blocking findings"), "blocking"),
    ...parseFindings(extractSection(latest.body, "Nonblocking notes"), "non_blocking"),
  ];

  return {
    decisionIdentity,
    reviewedPlanGenerationId,
    summary,
    findings,
    planReviewCycle,
  };
}
