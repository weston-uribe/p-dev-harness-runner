import { normalizeRepoUrl } from "../resolver/normalize-repo.js";

export function buildImplementationIdempotencyKey(input: {
  issueKey: string;
  targetRepo: string;
  branch: string;
}): string {
  const repo = normalizeRepoUrl(input.targetRepo);
  return `p-dev:build:${input.issueKey}:${repo}:${input.branch}`;
}

export function buildRevisionIdempotencyKey(input: {
  issueKey: string;
  pmFeedbackCommentId: string;
}): string {
  return `p-dev:revision:${input.issueKey}:${input.pmFeedbackCommentId}`;
}

export function buildIntegrationRepairIdempotencyKey(input: {
  issueKey: string;
  prUrl: string;
  repairCycleId: string;
  baseHeadSha: string;
  headSha: string;
}): string {
  return `p-dev:repair:${input.issueKey}:${input.prUrl}:${input.repairCycleId}:${input.baseHeadSha}:${input.headSha}`;
}
