import { createHash } from "node:crypto";

export interface MergeRequestIdentityInput {
  issueKey: string;
  targetRepository: string;
  prNumber: number;
  reviewedHeadSha: string;
  approvedReviewDecisionIdentity: string;
}

/**
 * Canonical merge subject string used for deterministic opaque job request ids.
 */
export function buildMergeRequestSubject(input: MergeRequestIdentityInput): string {
  const issueKey = input.issueKey.trim().toUpperCase();
  const repo = normalizeRepository(input.targetRepository);
  const prNumber = String(input.prNumber);
  const headSha = input.reviewedHeadSha.trim().toLowerCase();
  const decision = input.approvedReviewDecisionIdentity.trim().toLowerCase();
  return `merge-request:${issueKey}:${repo}:${prNumber}:${headSha}:${decision}`;
}

/**
 * Deterministic opaque request id for merge reconciliation / CLI dispatch.
 * Format: mrg-{sha256(subject)[0:32]}
 */
export function resolveMergeJobRequestId(input: MergeRequestIdentityInput): string {
  const subject = buildMergeRequestSubject(input);
  const digest = createHash("sha256").update(subject, "utf8").digest("hex");
  return `mrg-${digest.slice(0, 32)}`;
}

function normalizeRepository(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const githubMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i,
  );
  if (githubMatch) {
    return `${githubMatch[1]!.toLowerCase()}/${githubMatch[2]!.toLowerCase()}`;
  }
  if (trimmed.includes("/")) {
    const [owner, repo] = trimmed.split("/").filter(Boolean);
    if (owner && repo) {
      return `${owner.toLowerCase()}/${repo.replace(/\.git$/i, "").toLowerCase()}`;
    }
  }
  return trimmed.toLowerCase();
}
