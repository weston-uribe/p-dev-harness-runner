import {
  extractHarnessMetadataBlock,
  HarnessMarkerParseError,
  parseHarnessMarkers,
  type HarnessMarkers,
} from "../linear/markers.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import {
  assertCanonicalProviderIdentityHash,
  hashProviderIdentity,
} from "../identity/provider-identity-hash.js";
import { normalizeRepoUrl } from "../resolver/normalize-repo.js";
import {
  BuilderThreadLineageError,
  type BuilderThreadLineageFailureReason,
} from "./builder-thread-lineage-errors.js";
import type {
  BuilderThreadMarkerEvidence,
  BuilderThreadReference,
  BuilderThreadSourcePhase,
} from "./builder-thread-types.js";

const BUILDER_START_PHASES = new Set([
  "implementation_start",
  "revision_start",
  "repair_agent_start",
]);

const BUILDER_CARRY_PHASES = new Set([
  "implementation_start",
  "implementation",
  "handoff",
  "revision_start",
  "revision",
  "repair_agent_start",
  "repair_complete",
]);

const LEGACY_AGENT_PHASES = new Set(["implementation_start"]);

export interface ResolveBuilderThreadInput {
  comments: LinearCommentRecord[];
  orchestratorMarker: string;
  issueKey: string;
  targetRepo: string;
  branch?: string;
  prUrl?: string;
  previousImplementationRunId?: string;
  previousRevisionRunId?: string;
  workflowState?: {
    builderAgentId?: string | null;
    builderRunId?: string | null;
    issueKey?: string;
  } | null;
}

interface CandidateMarker {
  markers: HarnessMarkers;
  createdAt: number;
  commentId: string;
}

type MarkerLineageKind = "legacy" | "modern";

interface ValidatedCandidate {
  candidate: CandidateMarker;
  reference: BuilderThreadReference;
  generation: number;
}

function parseTime(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function privateBuilderAgentId(
  input: ResolveBuilderThreadInput,
): string | undefined {
  const agentId = input.workflowState?.builderAgentId?.trim();
  return agentId ? agentId : undefined;
}

function isOrchestratorMarker(
  markers: HarnessMarkers,
  orchestratorMarker: string,
): boolean {
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    Boolean(markers.phase) &&
    Boolean(markers.runId)
  );
}

function isBuilderCarryHarnessComment(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const block = extractHarnessMetadataBlock(commentBody);
  if (!block || !block.includes(orchestratorMarker)) {
    return false;
  }
  const phaseMatch = block.match(/^phase:\s*(\S+)/m);
  const phase = phaseMatch?.[1];
  return Boolean(phase && BUILDER_CARRY_PHASES.has(phase));
}

function readGeneration(markers: HarnessMarkers): number {
  const raw = markers.builderThreadGeneration;
  if (raw === undefined || raw === "") {
    return 1;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Number.NaN;
  }
  return parsed;
}

function hasHashOnlyIdentity(markers: HarnessMarkers): boolean {
  if (markers.builderAgentIdHash && !markers.builderAgentId) {
    return true;
  }
  const phase = markers.phase;
  if (
    phase &&
    BUILDER_START_PHASES.has(phase) &&
    markers.cursorAgentIdHash &&
    !markers.cursorAgentId
  ) {
    return true;
  }
  return false;
}

function classifyMarkerLineage(markers: HarnessMarkers): MarkerLineageKind | null {
  if (markers.builderAgentId || markers.builderAgentIdHash) {
    return "modern";
  }
  const phase = markers.phase;
  if (
    phase &&
    LEGACY_AGENT_PHASES.has(phase) &&
    markers.cursorAgentId &&
    !markers.builderAgentId &&
    !markers.builderAgentIdHash
  ) {
    return "legacy";
  }
  return null;
}

function resolveBuilderAgentId(markers: HarnessMarkers): string | undefined {
  if (markers.builderAgentId) {
    return markers.builderAgentId;
  }
  const phase = markers.phase;
  if (phase && BUILDER_START_PHASES.has(phase) && markers.cursorAgentId) {
    return markers.cursorAgentId;
  }
  return undefined;
}

function sourcePhaseFromMarkerPhase(
  phase: string | undefined,
): BuilderThreadSourcePhase | undefined {
  if (phase === "implementation_start" || phase === "implementation" || phase === "handoff") {
    return "implementation";
  }
  if (phase === "revision_start" || phase === "revision") {
    return "revision";
  }
  if (phase === "repair_agent_start" || phase === "repair_complete") {
    return "integration_repair";
  }
  return undefined;
}

function linksToImplementationRun(
  markers: HarnessMarkers,
  implementationRunId: string,
): boolean {
  if (markers.runId === implementationRunId && markers.phase === "implementation_start") {
    return true;
  }
  if (markers.builderOriginRunId === implementationRunId) {
    return true;
  }
  if (markers.previousImplementationRunId === implementationRunId) {
    return true;
  }
  return false;
}

function linksToRevisionRun(markers: HarnessMarkers, revisionRunId: string): boolean {
  if (
    markers.runId === revisionRunId &&
    (markers.phase === "revision_start" || markers.phase === "revision")
  ) {
    return true;
  }
  if (markers.previousRevisionRunId === revisionRunId) {
    return true;
  }
  return false;
}

function assertExactRepoMatch(
  markers: HarnessMarkers,
  input: ResolveBuilderThreadInput,
): void {
  if (!markers.targetRepo) {
    throw new BuilderThreadLineageError(
      "lineage_context_mismatch",
      "Builder marker is missing target_repo",
      { commentPhase: markers.phase, runId: markers.runId },
    );
  }
  const markerRepo = normalizeRepoUrl(markers.targetRepo);
  const expectedRepo = normalizeRepoUrl(input.targetRepo);
  if (markerRepo !== expectedRepo) {
    throw new BuilderThreadLineageError(
      "lineage_context_mismatch",
      "Builder marker target_repo does not match expected repository",
      { markerRepo, expectedRepo, commentPhase: markers.phase },
    );
  }
}

function assertExactLineageFields(
  markers: HarnessMarkers,
  input: ResolveBuilderThreadInput,
): void {
  assertExactRepoMatch(markers, input);

  if (input.prUrl) {
    if (!markers.prUrl) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker is missing pr_url for PR-scoped lineage resolution",
        { commentPhase: markers.phase, runId: markers.runId },
      );
    }
    if (markers.prUrl !== input.prUrl) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker pr_url does not match expected PR",
        {
          markerPrUrl: markers.prUrl,
          expectedPrUrl: input.prUrl,
          commentPhase: markers.phase,
        },
      );
    }
  }

  if (input.branch) {
    if (!markers.branch) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker is missing branch for branch-scoped lineage resolution",
        { commentPhase: markers.phase, runId: markers.runId },
      );
    }
    if (markers.branch !== input.branch) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker branch does not match expected branch",
        {
          markerBranch: markers.branch,
          expectedBranch: input.branch,
          commentPhase: markers.phase,
        },
      );
    }
  }

  if (markers.issueKey && markers.issueKey !== input.issueKey) {
    throw new BuilderThreadLineageError(
      "lineage_context_mismatch",
      "Builder marker issue_key does not match expected issue",
      { markerIssueKey: markers.issueKey, expectedIssueKey: input.issueKey },
    );
  }

  if (input.previousImplementationRunId) {
    if (!linksToImplementationRun(markers, input.previousImplementationRunId)) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker does not link to the expected implementation run",
        {
          expectedImplementationRunId: input.previousImplementationRunId,
          commentPhase: markers.phase,
          runId: markers.runId,
        },
      );
    }
  }

  if (input.previousRevisionRunId) {
    if (!linksToRevisionRun(markers, input.previousRevisionRunId)) {
      throw new BuilderThreadLineageError(
        "lineage_context_mismatch",
        "Builder marker does not link to the expected revision run",
        {
          expectedRevisionRunId: input.previousRevisionRunId,
          commentPhase: markers.phase,
          runId: markers.runId,
        },
      );
    }
  }
}

function assertValidGeneration(markers: HarnessMarkers, commentId: string): number {
  if (
    markers.builderThreadGeneration !== undefined &&
    markers.builderThreadGeneration !== ""
  ) {
    const generation = readGeneration(markers);
    if (Number.isNaN(generation)) {
      throw new BuilderThreadLineageError(
        "malformed_generation",
        "Builder marker has malformed builder_thread_generation",
        {
          commentId,
          rawGeneration: markers.builderThreadGeneration,
          commentPhase: markers.phase,
        },
      );
    }
    return generation;
  }
  return 1;
}

function assertMarkerShape(
  markers: HarnessMarkers,
  input: ResolveBuilderThreadInput,
  commentId: string,
): MarkerLineageKind {
  const kind = classifyMarkerLineage(markers);
  if (!kind) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Builder marker is neither a valid legacy implementation_start marker nor a modern builder identity marker",
      { commentId, commentPhase: markers.phase, runId: markers.runId },
    );
  }

  assertExactLineageFields(markers, input);
  assertValidGeneration(markers, commentId);

  if (kind === "legacy") {
    if (markers.phase !== "implementation_start" || !markers.cursorAgentId) {
      throw new BuilderThreadLineageError(
        "invalid_legacy_marker",
        "Legacy Builder lineage is only valid on implementation_start markers",
        { commentId, commentPhase: markers.phase },
      );
    }
    if (input.prUrl && !markers.branch) {
      throw new BuilderThreadLineageError(
        "invalid_legacy_marker",
        "Legacy implementation_start marker is missing branch for PR-scoped resolution",
        { commentId, runId: markers.runId },
      );
    }
    return kind;
  }

  if (!markers.builderAgentId && !markers.builderAgentIdHash) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Modern Builder marker is missing builder identity",
      { commentId, commentPhase: markers.phase },
    );
  }

  if (markers.builderAgentIdHash) {
    assertCanonicalProviderIdentityHash(markers.builderAgentIdHash);
  }

  if (!privateBuilderAgentId(input) && hasHashOnlyIdentity(markers)) {
    throw new BuilderThreadLineageError(
      "missing_private_identity",
      "Builder marker exposes only a hashed identity; private workflow state is required to resume",
      { commentId, commentPhase: markers.phase },
    );
  }

  if (!privateBuilderAgentId(input) && !resolveBuilderAgentId(markers)) {
    throw new BuilderThreadLineageError(
      "missing_private_identity",
      "Builder marker cannot be resumed without private workflow state",
      { commentId, commentPhase: markers.phase },
    );
  }

  if (input.prUrl && !markers.prUrl) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Modern Builder marker is missing pr_url",
      { commentId, commentPhase: markers.phase },
    );
  }

  if (input.branch && !markers.branch) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Modern Builder marker is missing branch",
      { commentId, commentPhase: markers.phase },
    );
  }

  return kind;
}

function toReference(
  markers: HarnessMarkers,
  input: ResolveBuilderThreadInput,
  kind: MarkerLineageKind,
  agentIdOverride?: string,
): BuilderThreadReference {
  const agentId = agentIdOverride ?? resolveBuilderAgentId(markers);
  if (!agentId) {
    throw new BuilderThreadLineageError(
      kind === "legacy" ? "invalid_legacy_marker" : "incomplete_modern_marker",
      "Builder marker is missing a resolvable agent id",
      { commentPhase: markers.phase, runId: markers.runId },
    );
  }
  const generation = readGeneration(markers);
  const sourcePhase = sourcePhaseFromMarkerPhase(markers.phase);
  if (!sourcePhase) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Builder marker phase cannot be mapped to a Builder source phase",
      { commentPhase: markers.phase },
    );
  }
  const originRunId =
    markers.builderOriginRunId ??
    markers.runId ??
    input.workflowState?.builderRunId ??
    input.previousImplementationRunId;
  if (!originRunId) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Builder marker is missing origin run lineage",
      { commentPhase: markers.phase, runId: markers.runId },
    );
  }
  return {
    agentId,
    generation,
    originHarnessRunId: originRunId,
    latestHarnessRunId: markers.runId ?? originRunId,
    sourcePhase,
    targetRepo: normalizeRepoUrl(markers.targetRepo ?? input.targetRepo),
    branch: markers.branch ?? input.branch,
    prUrl: markers.prUrl ?? input.prUrl,
    idempotencyKey: markers.builderThreadIdempotencyKey,
  };
}

function buildReferenceFromPrivateState(
  input: ResolveBuilderThreadInput,
  markers: HarnessMarkers | null,
  sourcePhaseOverride?: BuilderThreadSourcePhase,
): BuilderThreadReference {
  const agentId = privateBuilderAgentId(input)!;
  const generation = markers ? readGeneration(markers) : 1;
  const sourcePhase =
    sourcePhaseOverride ??
    (markers ? sourcePhaseFromMarkerPhase(markers.phase) : undefined) ??
    "implementation";
  const originRunId =
    markers?.builderOriginRunId ??
    markers?.runId ??
    input.workflowState?.builderRunId ??
    input.previousImplementationRunId ??
    input.workflowState?.builderRunId;
  if (!originRunId) {
    throw new BuilderThreadLineageError(
      "incomplete_modern_marker",
      "Private builder lineage is missing origin run context",
      { builderAgentId: agentId },
    );
  }
  return {
    agentId,
    generation,
    originHarnessRunId: originRunId,
    latestHarnessRunId: markers?.runId ?? originRunId,
    sourcePhase,
    targetRepo: normalizeRepoUrl(markers?.targetRepo ?? input.targetRepo),
    branch: markers?.branch ?? input.branch,
    prUrl: markers?.prUrl ?? input.prUrl,
    idempotencyKey: markers?.builderThreadIdempotencyKey,
  };
}

function validateMarkerIdentityAgainstState(
  markers: HarnessMarkers,
  builderAgentId: string,
  commentId: string,
): void {
  if (markers.builderAgentIdHash) {
    assertCanonicalProviderIdentityHash(markers.builderAgentIdHash);
    if (hashProviderIdentity(builderAgentId) !== markers.builderAgentIdHash) {
      throw new BuilderThreadLineageError(
        "hash_state_mismatch",
        "Builder marker hash does not match private workflow state builder identity",
        {
          commentId,
          commentPhase: markers.phase,
          markerHash: markers.builderAgentIdHash,
        },
      );
    }
  }

  if (markers.builderAgentId && markers.builderAgentId !== builderAgentId) {
    throw new BuilderThreadLineageError(
      "legacy_state_mismatch",
      "Builder marker raw agent id does not match private workflow state",
      {
        commentId,
        commentPhase: markers.phase,
        markerAgentId: markers.builderAgentId,
      },
    );
  }

  if (
    markers.phase &&
    BUILDER_START_PHASES.has(markers.phase) &&
    markers.cursorAgentId &&
    markers.cursorAgentId !== builderAgentId
  ) {
    throw new BuilderThreadLineageError(
      "legacy_state_mismatch",
      "Legacy cursor agent id does not match private workflow state",
      {
        commentId,
        commentPhase: markers.phase,
        markerAgentId: markers.cursorAgentId,
      },
    );
  }

  if (
    markers.phase &&
    BUILDER_START_PHASES.has(markers.phase) &&
    markers.cursorAgentIdHash
  ) {
    assertCanonicalProviderIdentityHash(markers.cursorAgentIdHash);
    if (hashProviderIdentity(builderAgentId) !== markers.cursorAgentIdHash) {
      throw new BuilderThreadLineageError(
        "hash_state_mismatch",
        "Legacy cursor agent hash does not match private workflow state builder identity",
        {
          commentId,
          commentPhase: markers.phase,
          markerHash: markers.cursorAgentIdHash,
        },
      );
    }
  }
}

function parseMarkersForLineage(
  commentBody: string,
  orchestratorMarker: string,
  commentId: string,
): HarnessMarkers | null {
  try {
    return parseHarnessMarkers(commentBody);
  } catch (error) {
    if (error instanceof HarnessMarkerParseError) {
      if (isBuilderCarryHarnessComment(commentBody, orchestratorMarker)) {
        throw new BuilderThreadLineageError(
          "invalid_identity_hash_marker",
          error.message,
          { commentId, parseErrorCode: error.code },
        );
      }
      return null;
    }
    throw error;
  }
}

function collectCandidates(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
): CandidateMarker[] {
  const candidates: CandidateMarker[] = [];
  for (const comment of comments) {
    const markers = parseMarkersForLineage(
      comment.body,
      orchestratorMarker,
      comment.id,
    );
    if (!markers) {
      continue;
    }
    if (!isOrchestratorMarker(markers, orchestratorMarker)) {
      continue;
    }
    if (!markers.phase || !BUILDER_CARRY_PHASES.has(markers.phase)) {
      continue;
    }
    if (!resolveBuilderAgentId(markers) && !classifyMarkerLineage(markers)) {
      continue;
    }
    candidates.push({
      markers,
      createdAt: parseTime(comment.createdAt),
      commentId: comment.id,
    });
  }
  return candidates;
}

function selectHighestGenerationWinner(
  entries: ValidatedCandidate[],
): ValidatedCandidate {
  const maxGeneration = Math.max(...entries.map((entry) => entry.generation));
  const atMaxGeneration = entries.filter((entry) => entry.generation === maxGeneration);
  const agentIds = new Set(atMaxGeneration.map((entry) => entry.reference.agentId));
  if (agentIds.size > 1) {
    throw new BuilderThreadLineageError(
      "conflicting_agent_ids",
      "Multiple conflicting Builder agent IDs share the highest generation",
      {
        generation: maxGeneration,
        agentIds: [...agentIds],
        commentIds: atMaxGeneration.map((entry) => entry.candidate.commentId),
      },
    );
  }
  atMaxGeneration.sort((a, b) => b.candidate.createdAt - a.candidate.createdAt);
  const winner = atMaxGeneration[0];
  if (!winner) {
    throw new BuilderThreadLineageError(
      "lineage_context_mismatch",
      "No Builder reference remained after generation selection",
    );
  }
  return winner;
}

function rejectConflictingHighestGeneration(
  entries: ValidatedCandidate[],
): BuilderThreadReference {
  return selectHighestGenerationWinner(entries).reference;
}

const SOFT_SKIP_LINEAGE_REASONS = new Set<BuilderThreadLineageFailureReason>([
  "lineage_context_mismatch",
  "incomplete_modern_marker",
  "invalid_legacy_marker",
]);

function resolveValidatedCandidates(input: ResolveBuilderThreadInput): ValidatedCandidate[] {
  const rawCandidates = collectCandidates(input.comments, input.orchestratorMarker);
  if (rawCandidates.length === 0) {
    return [];
  }

  const stateAgentId = privateBuilderAgentId(input);
  const validated: ValidatedCandidate[] = [];

  for (const candidate of rawCandidates) {
    try {
      const kind = assertMarkerShape(candidate.markers, input, candidate.commentId);
      const generation = assertValidGeneration(candidate.markers, candidate.commentId);
      validated.push({
        candidate,
        reference: toReference(
          candidate.markers,
          input,
          kind,
          stateAgentId,
        ),
        generation,
      });
    } catch (error) {
      if (error instanceof BuilderThreadLineageError) {
        if (SOFT_SKIP_LINEAGE_REASONS.has(error.reason)) {
          continue;
        }
        throw error;
      }
      throw error;
    }
  }

  return validated;
}

export function resolveBuilderThreadReference(
  input: ResolveBuilderThreadInput,
): BuilderThreadReference | null {
  const stateAgentId = privateBuilderAgentId(input);

  if (stateAgentId) {
    const validated = resolveValidatedCandidates(input);
    for (const entry of validated) {
      validateMarkerIdentityAgainstState(
        entry.candidate.markers,
        stateAgentId,
        entry.candidate.commentId,
      );
    }

    if (validated.length === 0) {
      return buildReferenceFromPrivateState(input, null);
    }

    const winner = selectHighestGenerationWinner(validated);
    return buildReferenceFromPrivateState(input, winner.candidate.markers);
  }

  const validated = resolveValidatedCandidates(input);
  if (validated.length === 0) {
    return null;
  }

  if (validated.some((entry) => hasHashOnlyIdentity(entry.candidate.markers))) {
    throw new BuilderThreadLineageError(
      "missing_private_identity",
      "Builder marker exposes only a hashed identity; private workflow state is required to resume",
    );
  }

  return rejectConflictingHighestGeneration(validated);
}

export function resolveBuilderThreadMarkerEvidence(
  input: ResolveBuilderThreadInput,
): BuilderThreadMarkerEvidence | null {
  const reference = resolveBuilderThreadReference(input);
  if (!reference) {
    return null;
  }

  const winner = resolveValidatedCandidates(input)
    .filter((entry) => entry.reference.agentId === reference.agentId)
    .sort((a, b) => b.candidate.createdAt - a.candidate.createdAt)[0]?.candidate.markers;
  if (!winner) {
    return null;
  }

  return {
    builderAgentId: reference.agentId,
    builderThreadGeneration: reference.generation,
    builderThreadAction:
      winner.builderThreadAction as BuilderThreadMarkerEvidence["builderThreadAction"],
    builderOriginRunId: winner.builderOriginRunId ?? winner.runId,
    builderThreadIdempotencyKey: winner.builderThreadIdempotencyKey,
    previousBuilderAgentId: winner.previousBuilderAgentId,
    builderThreadReplacementReason:
      winner.builderThreadReplacementReason as BuilderThreadMarkerEvidence["builderThreadReplacementReason"],
  };
}

export function findImplementationStartBuilderAgentId(
  comments: LinearCommentRecord[],
  orchestratorMarker: string,
  implementationRunId: string,
  targetRepo: string,
): string | null {
  for (const comment of comments) {
    let markers: HarnessMarkers | null;
    try {
      markers = parseMarkersForLineage(comment.body, orchestratorMarker, comment.id);
    } catch {
      continue;
    }
    if (!markers) {
      continue;
    }
    if (
      markers.orchestratorMarker !== orchestratorMarker ||
      markers.phase !== "implementation_start" ||
      markers.runId !== implementationRunId
    ) {
      continue;
    }
    if (
      markers.targetRepo &&
      normalizeRepoUrl(markers.targetRepo) !== normalizeRepoUrl(targetRepo)
    ) {
      continue;
    }
    return resolveBuilderAgentId(markers) ?? null;
  }
  return null;
}

export { BuilderThreadLineageError, type BuilderThreadLineageFailureReason };
