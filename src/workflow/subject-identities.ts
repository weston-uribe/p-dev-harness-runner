/**
 * Deterministic subject identities for handoff and review deduplication.
 * Reviewer/execution generation must not make duplicate decisions appear unique.
 */

import { createHash } from "node:crypto";

function hashIdentity(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export function buildHandoffSubjectIdentity(input: {
  issueKey: string;
  targetRepo: string;
  implementationGenerationId: string;
  prNumber: number;
  headSha: string;
  diffHash: string;
}): string {
  return hashIdentity([
    "handoff",
    input.issueKey.trim(),
    input.targetRepo.trim(),
    input.implementationGenerationId.trim(),
    String(input.prNumber),
    input.headSha.trim().toLowerCase(),
    input.diffHash.trim().toLowerCase(),
  ]);
}

export function buildPlanReviewSubjectIdentity(input: {
  issueKey: string;
  planGenerationId: string;
  planHash: string;
  reviewCycle: number;
}): string {
  return hashIdentity([
    "plan_review_subject",
    input.issueKey.trim(),
    input.planGenerationId.trim(),
    input.planHash.trim().toLowerCase(),
    String(input.reviewCycle),
  ]);
}

export function buildCodeReviewSubjectIdentity(input: {
  issueKey: string;
  prNumber: number;
  headSha: string;
  diffHash: string;
  reviewCycle: number;
}): string {
  return hashIdentity([
    "code_review_subject",
    input.issueKey.trim(),
    String(input.prNumber),
    input.headSha.trim().toLowerCase(),
    input.diffHash.trim().toLowerCase(),
    String(input.reviewCycle),
  ]);
}

/** Accepted decision identity — subject + decision only (not reviewer generation). */
export function buildAcceptedReviewDecisionIdentity(input: {
  decision: "approved" | "needs_revision";
  subjectIdentity: string;
}): string {
  return hashIdentity([
    "accepted_review_decision",
    input.decision,
    input.subjectIdentity,
  ]);
}
