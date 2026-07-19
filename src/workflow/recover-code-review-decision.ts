/**
 * Recover Code Review needs_revision decision context from durable Linear
 * comments when issue-scoped workflow-state.json is absent (ephemeral GHA).
 */

import { parseHarnessMarkers } from "../linear/markers.js";
import type { AcceptedReviewDecision } from "./state/types.js";
import type { ReviewFinding } from "./review-contracts.js";

export interface LinearCommentLike {
  body: string;
  createdAt?: string;
}

function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(
    `### ${heading}\\n([\\s\\S]*?)(?:\\n### |\\n<!--|\\n---\\n|$)`,
  );
  return body.match(pattern)?.[1]?.trim() ?? "";
}

/**
 * Parse findings formatted by formatCodeReviewComment:
 * `- **F1** (requirements) — \`README.md\`:93: evidence`
 * `- **F1** (requirements): evidence`
 */
function parseFindings(
  section: string,
  severity: "blocking" | "non_blocking",
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (!section || /^_None\._$/i.test(section.trim())) {
    return findings;
  }
  const lines = section.split("\n");
  let current: ReviewFinding | null = null;
  for (const line of lines) {
    const main = line.match(
      /^- \*\*([^*]+)\*\* \(([^)]+)\)(?: — `([^`]+)`(?::(\d+))?)?:\s*(.+)$/,
    );
    if (main) {
      if (current) findings.push(current);
      current = {
        id: main[1]!.trim(),
        severity,
        category: main[2]!.trim(),
        evidence: main[5]!.trim(),
        ...(main[3] ? { path: main[3].trim() } : {}),
        ...(main[4] ? { line: Number(main[4]) } : {}),
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
 * Newest Code Review comment with Decision: needs_revision.
 */
export function recoverCodeReviewRevisionFromComments(input: {
  comments: readonly LinearCommentLike[];
  orchestratorMarker: string;
}): AcceptedReviewDecision | null {
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
        c.markers.phase === "code_review" &&
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

  const reviewedPrNumberRaw =
    latest.body.match(/reviewed_pr_number:\s*(\d+)/)?.[1] ??
    latest.body.match(/Reviewed PR:\s*#(\d+)/)?.[1] ??
    null;
  const reviewedHeadSha =
    latest.body.match(/reviewed_head_sha:\s*(\S+)/)?.[1] ??
    latest.body.match(/Reviewed head SHA:\s*`([^`]+)`/)?.[1] ??
    undefined;
  const reviewedDiffHash =
    latest.body.match(/reviewed_diff_hash:\s*(\S+)/)?.[1] ??
    latest.body.match(/Reviewed diff hash:\s*`([^`]+)`/)?.[1] ??
    undefined;

  const findings = [
    ...parseFindings(extractSection(latest.body, "Blocking findings"), "blocking"),
    ...parseFindings(
      extractSection(latest.body, "Nonblocking notes"),
      "non_blocking",
    ),
  ];

  if (!findings.some((f) => f.severity === "blocking")) {
    return null;
  }

  return {
    decision: "needs_revision",
    decisionIdentity,
    phaseId: "code_review",
    acceptedAt: latest.createdAt ?? new Date(0).toISOString(),
    ...(reviewedPrNumberRaw
      ? { reviewedPrNumber: Number(reviewedPrNumberRaw) }
      : {}),
    ...(reviewedHeadSha ? { reviewedHeadSha } : {}),
    ...(reviewedDiffHash ? { reviewedDiffHash } : {}),
    findings: findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      evidence: f.evidence,
      ...(f.requiredChange ? { requiredChange: f.requiredChange } : {}),
      ...(f.path ? { file: f.path } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
    })),
  };
}
