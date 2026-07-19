/**
 * Recover implementation/PR artifact identity from durable Linear handoff
 * comments when issue-scoped workflow-state.json is absent (ephemeral GHA runners).
 */

import { createHash } from "node:crypto";
import { parseHarnessMarkers } from "../linear/markers.js";
import { parsePrUrl } from "../github/pr-url.js";
import { normalizeRepoUrl } from "../resolver/normalize-repo.js";
import {
  createImplementationArtifactIdentity,
  hashDiffIdentity,
  type ImplementationArtifactIdentity,
} from "./implementation-artifact.js";

export interface LinearCommentLike {
  body: string;
  createdAt?: string;
}

export interface RecoveredPrLocator {
  prUrl: string;
  prNumber: number;
  builderRunId: string;
  targetRepository: string;
  branch?: string;
  implementationGenerationId?: string;
  headSha?: string;
  baseSha?: string;
  diffHash?: string;
  createdAt?: string;
}

/**
 * Locate the newest handoff completion comment that carries a PR URL.
 */
export function recoverPrLocatorFromHandoffComments(input: {
  comments: readonly LinearCommentLike[];
  orchestratorMarker: string;
  targetRepository: string;
}): RecoveredPrLocator | null {
  const handoffCandidates = input.comments
    .map((c, index) => ({
      body: c.body,
      markers: parseHarnessMarkers(c.body),
      createdAt: c.createdAt,
      index,
    }))
    .filter(
      (c) =>
        c.markers.orchestratorMarker === input.orchestratorMarker &&
        c.markers.phase === "handoff" &&
        Boolean(c.markers.runId) &&
        Boolean(c.markers.prUrl),
    )
    .sort((a, b) => {
      const aMarked = a.markers.implementationGenerationId ? 1 : 0;
      const bMarked = b.markers.implementationGenerationId ? 1 : 0;
      if (aMarked !== bMarked) return bMarked - aMarked;
      const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      // Newest-first list: lower index is newer.
      return a.index - b.index;
    });

  const handoff = handoffCandidates[0];
  if (!handoff?.markers.runId || !handoff.markers.prUrl) return null;

  const parsed = parsePrUrl(handoff.markers.prUrl);
  if (!parsed) return null;

  const markerRepo = handoff.markers.targetRepo
    ? normalizeRepoUrl(handoff.markers.targetRepo)
    : normalizeRepoUrl(input.targetRepository);

  return {
    prUrl: handoff.markers.prUrl,
    prNumber: parsed.pullNumber,
    builderRunId: handoff.markers.runId,
    targetRepository: markerRepo,
    branch: handoff.markers.branch,
    implementationGenerationId: handoff.markers.implementationGenerationId,
    headSha: handoff.markers.prHeadSha,
    baseSha: handoff.markers.prBaseSha,
    diffHash: handoff.markers.diffHash,
    createdAt: handoff.createdAt,
  };
}

/**
 * Build a durable implementation artifact from a recovered PR locator plus
 * live GitHub SHAs.
 *
 * Live head/base are authoritative: handoff markers go stale after Code Revision
 * mutates the PR tip. Marker SHAs/diff/generation are reused only when they still
 * match the live tip.
 */
export function buildRecoveredImplementationArtifact(input: {
  locator: RecoveredPrLocator;
  headSha: string;
  baseSha: string;
  workflowStateRevision?: number;
}): ImplementationArtifactIdentity {
  const headSha = input.headSha;
  const baseSha = input.baseSha;
  const liveMatchesLocator =
    Boolean(input.locator.headSha) &&
    Boolean(input.locator.baseSha) &&
    input.locator.headSha === headSha &&
    input.locator.baseSha === baseSha;
  const diffHash =
    liveMatchesLocator && input.locator.diffHash
      ? input.locator.diffHash
      : hashDiffIdentity({
          prNumber: input.locator.prNumber,
          headSha,
          baseSha,
        });
  const implementationGenerationId =
    liveMatchesLocator &&
    input.locator.implementationGenerationId &&
    input.locator.implementationGenerationId.trim().length > 0
      ? input.locator.implementationGenerationId.trim()
      : `impl-recovered-${createHash("sha256")
          .update(
            `${input.locator.builderRunId}:${input.locator.prNumber}:${headSha}`,
          )
          .digest("hex")
          .slice(0, 32)}`;

  return createImplementationArtifactIdentity({
    targetRepository: input.locator.targetRepository,
    prNumber: input.locator.prNumber,
    prUrl: input.locator.prUrl,
    headSha,
    baseSha,
    builderRunId: input.locator.builderRunId,
    workflowStateRevision: input.workflowStateRevision ?? 1,
    createdAt: input.locator.createdAt,
    implementationGenerationId,
    diffHash,
  });
}
