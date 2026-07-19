/**
 * Immutable implementation / PR artifact identity for Code Review correlation.
 */

import { createHash, randomUUID } from "node:crypto";

export interface ImplementationArtifactIdentity {
  implementationGenerationId: string;
  targetRepository: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
  diffHash: string;
  builderRunId: string;
  acceptanceEvidenceId: string | null;
  testEvidenceId: string | null;
  workflowStateRevision: number;
  createdAt: string;
  supersedesImplementationGenerationId: string | null;
  /** Review decision that caused this revision, when applicable. */
  causedByReviewDecisionIdentity: string | null;
}

export function hashDiffIdentity(input: {
  prNumber: number;
  headSha: string;
  baseSha: string;
  /** Optional normalized patch/diff body; when omitted, identity is SHA-derived. */
  diffBody?: string;
}): string {
  const material =
    input.diffBody ??
    `${input.prNumber}|${input.headSha}|${input.baseSha}`;
  return createHash("sha256").update(material).digest("hex");
}

export function createImplementationArtifactIdentity(input: {
  targetRepository: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
  builderRunId: string;
  workflowStateRevision: number;
  acceptanceEvidenceId?: string | null;
  testEvidenceId?: string | null;
  createdAt?: string;
  supersedesImplementationGenerationId?: string | null;
  causedByReviewDecisionIdentity?: string | null;
  implementationGenerationId?: string;
  diffBody?: string;
  diffHash?: string;
}): ImplementationArtifactIdentity {
  return {
    implementationGenerationId:
      input.implementationGenerationId ?? randomUUID(),
    targetRepository: input.targetRepository,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    headSha: input.headSha,
    baseSha: input.baseSha,
    diffHash:
      input.diffHash ??
      hashDiffIdentity({
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha,
        diffBody: input.diffBody,
      }),
    builderRunId: input.builderRunId,
    acceptanceEvidenceId: input.acceptanceEvidenceId ?? null,
    testEvidenceId: input.testEvidenceId ?? null,
    workflowStateRevision: input.workflowStateRevision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    supersedesImplementationGenerationId:
      input.supersedesImplementationGenerationId ?? null,
    causedByReviewDecisionIdentity:
      input.causedByReviewDecisionIdentity ?? null,
  };
}

export type ImplementationArtifactMatchRejectReason =
  | "missing_latest_implementation"
  | "superseded_implementation"
  | "newer_implementation_exists"
  | "pr_number_mismatch"
  | "repository_mismatch"
  | "head_sha_mismatch"
  | "base_sha_mismatch"
  | "diff_hash_mismatch"
  | "stale_workflow_revision";

export function assertImplementationArtifactMatch(input: {
  latest: ImplementationArtifactIdentity | null;
  reviewedPrNumber: number;
  reviewedHeadSha: string;
  reviewedDiffHash: string;
  reviewedBaseSha?: string;
  targetRepository?: string;
  expectedStateRevision?: number;
  supersededGenerationIds?: readonly string[];
  reviewedImplementationGenerationId?: string;
}):
  | { ok: true }
  | { ok: false; reason: ImplementationArtifactMatchRejectReason } {
  if (!input.latest) {
    return { ok: false, reason: "missing_latest_implementation" };
  }
  if (
    input.reviewedImplementationGenerationId &&
    input.supersededGenerationIds?.includes(
      input.reviewedImplementationGenerationId,
    )
  ) {
    return { ok: false, reason: "superseded_implementation" };
  }
  if (
    input.reviewedImplementationGenerationId &&
    input.latest.implementationGenerationId !==
      input.reviewedImplementationGenerationId
  ) {
    return { ok: false, reason: "newer_implementation_exists" };
  }
  if (input.latest.prNumber !== input.reviewedPrNumber) {
    return { ok: false, reason: "pr_number_mismatch" };
  }
  if (
    input.targetRepository &&
    input.latest.targetRepository !== input.targetRepository
  ) {
    return { ok: false, reason: "repository_mismatch" };
  }
  if (input.latest.headSha !== input.reviewedHeadSha) {
    return { ok: false, reason: "head_sha_mismatch" };
  }
  if (
    input.reviewedBaseSha &&
    input.latest.baseSha !== input.reviewedBaseSha
  ) {
    return { ok: false, reason: "base_sha_mismatch" };
  }
  if (input.latest.diffHash !== input.reviewedDiffHash) {
    return { ok: false, reason: "diff_hash_mismatch" };
  }
  if (
    input.expectedStateRevision !== undefined &&
    input.expectedStateRevision < input.latest.workflowStateRevision
  ) {
    return { ok: false, reason: "stale_workflow_revision" };
  }
  return { ok: true };
}
