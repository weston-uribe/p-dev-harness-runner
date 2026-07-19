/**
 * Immutable plan artifact identity for Plan Review correlation.
 */

import { createHash, randomUUID } from "node:crypto";

export interface PlanArtifactIdentity {
  planGenerationId: string;
  planArtifactHash: string;
  plannerRunId: string;
  promptContractVersion: string;
  workflowStateRevision: number;
  createdAt: string;
  supersedesPlanGenerationId: string | null;
  /** Review decision that caused this revision, when applicable. */
  causedByReviewDecisionIdentity: string | null;
}

export function hashPlanArtifactBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createPlanArtifactIdentity(input: {
  planBody: string;
  plannerRunId: string;
  promptContractVersion: string;
  workflowStateRevision: number;
  createdAt?: string;
  supersedesPlanGenerationId?: string | null;
  causedByReviewDecisionIdentity?: string | null;
  planGenerationId?: string;
}): PlanArtifactIdentity {
  return {
    planGenerationId: input.planGenerationId ?? randomUUID(),
    planArtifactHash: hashPlanArtifactBody(input.planBody),
    plannerRunId: input.plannerRunId,
    promptContractVersion: input.promptContractVersion,
    workflowStateRevision: input.workflowStateRevision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    supersedesPlanGenerationId: input.supersedesPlanGenerationId ?? null,
    causedByReviewDecisionIdentity:
      input.causedByReviewDecisionIdentity ?? null,
  };
}

export type PlanArtifactMatchRejectReason =
  | "missing_latest_plan"
  | "superseded_plan"
  | "plan_hash_mismatch"
  | "newer_plan_exists"
  | "stale_workflow_revision";

export function assertPlanArtifactMatch(input: {
  latest: PlanArtifactIdentity | null;
  reviewedPlanGenerationId: string;
  reviewedPlanArtifactHash: string;
  expectedStateRevision?: number;
  supersededGenerationIds?: readonly string[];
}): { ok: true } | { ok: false; reason: PlanArtifactMatchRejectReason } {
  if (!input.latest) {
    return { ok: false, reason: "missing_latest_plan" };
  }
  if (
    input.supersededGenerationIds?.includes(input.reviewedPlanGenerationId)
  ) {
    return { ok: false, reason: "superseded_plan" };
  }
  if (input.latest.planGenerationId !== input.reviewedPlanGenerationId) {
    return { ok: false, reason: "newer_plan_exists" };
  }
  if (input.latest.planArtifactHash !== input.reviewedPlanArtifactHash) {
    return { ok: false, reason: "plan_hash_mismatch" };
  }
  if (
    input.expectedStateRevision !== undefined &&
    input.latest.workflowStateRevision !== input.expectedStateRevision &&
    input.expectedStateRevision < input.latest.workflowStateRevision
  ) {
    return { ok: false, reason: "stale_workflow_revision" };
  }
  return { ok: true };
}
