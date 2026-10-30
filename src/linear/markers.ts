import {
  assertCanonicalProviderIdentityHash,
  hashProviderIdentity,
  ProviderIdentityHashError,
} from "../identity/provider-identity-hash.js";

export type HarnessMarkerParseErrorCode =
  | "invalid_identity_hash_marker"
  | "conflicting_identity_markers";

export class HarnessMarkerParseError extends Error {
  readonly code: HarnessMarkerParseErrorCode;

  constructor(code: HarnessMarkerParseErrorCode, message: string) {
    super(message);
    this.name = "HarnessMarkerParseError";
    this.code = code;
  }
}

export interface HarnessMarkers {
  orchestratorMarker?: string;
  phase?: string;
  runId?: string;
  cursorAgentId?: string;
  cursorAgentIdHash?: string;
  cursorRunId?: string;
  cursorRunIdHash?: string;
  builderAgentId?: string;
  builderAgentIdHash?: string;
  builderThreadGeneration?: string;
  builderThreadAction?: string;
  builderOriginRunId?: string;
  builderThreadIdempotencyKey?: string;
  previousBuilderAgentId?: string;
  previousBuilderAgentIdHash?: string;
  builderThreadReplacementReason?: string;
  model?: string;
  promptVersion?: string;
  targetRepo?: string;
  baseBranch?: string;
  branch?: string;
  prUrl?: string;
  previewUrl?: string;
  previousImplementationRunId?: string;
  previousHandoffRunId?: string;
  pmFeedbackCommentId?: string;
  previousRevisionRunId?: string;
  mergeCommitSha?: string;
  deploymentUrl?: string;
  githubActionsRunUrl?: string;
  issueKey?: string;
  prNumber?: string;
  productionBranch?: string;
  integrationSuccessStatus?: string;
  productionHeadSha?: string;
  previousMergeRunId?: string;
  promotionProofMethod?: string;
  productionCompletionId?: string;
  productionEffectId?: string;
  repairAttempt?: string;
  repairPath?: string;
  triggerReason?: string;
  conflictFiles?: string;
  dependencyClosureFiles?: string;
  touchedFiles?: string;
  repairCycleId?: string;
  executionEnvironment?: string;
  executionEnvironmentMarker?: string;
  hostname?: string;
  codespaceName?: string;
  githubRunId?: string;
  githubWorkflow?: string;
  gitBranch?: string;
  gitSha?: string;
  planGenerationId?: string;
  planArtifactHash?: string;
  implementationGenerationId?: string;
  prHeadSha?: string;
  prBaseSha?: string;
  diffHash?: string;
  /** Deterministic handoff subject identity for idempotent skip. */
  handoffSubjectIdentity?: string;
  /** Deterministic review subject identity for dedupe. */
  reviewSubjectIdentity?: string;
  decisionIdentity?: string;
}

const HARNESS_HTML_METADATA_PATTERN = /<!--\s*([\s\S]*?)\s*-->/g;

export function extractHarnessMetadataBlock(commentBody: string): string | null {
  const matches = [...commentBody.matchAll(HARNESS_HTML_METADATA_PATTERN)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const block = matches[index]?.[1]?.trim();
    if (
      block &&
      (block.includes("harness-orchestrator-v1") ||
        /\nphase:\s*\S+/m.test(block) ||
        /^phase:\s*\S+/m.test(block))
    ) {
      return block;
    }
  }
  return null;
}

const IDENTITY_HASH_MARKER_KEYS = new Set([
  "cursor_agent_id_hash",
  "cursor_run_id_hash",
  "builder_agent_id_hash",
  "previous_builder_agent_id_hash",
]);

function assertIdentityHashMarker(key: string, value: string): void {
  try {
    assertCanonicalProviderIdentityHash(value);
  } catch (error) {
    if (error instanceof ProviderIdentityHashError) {
      throw new HarnessMarkerParseError(
        "invalid_identity_hash_marker",
        `Invalid identity hash marker "${key}": ${error.message}`,
      );
    }
    throw error;
  }
}

function recordMarkerKey(
  seenKeys: Map<string, string>,
  key: string,
  value: string,
): void {
  const existing = seenKeys.get(key);
  if (existing !== undefined && existing !== value) {
    throw new HarnessMarkerParseError(
      "conflicting_identity_markers",
      `Conflicting values for marker key "${key}".`,
    );
  }
  seenKeys.set(key, value);
}

function assertIdentityMarkerConsistency(markers: HarnessMarkers): void {
  const pairs: Array<{
    rawKey: string;
    hashKey: string;
    raw?: string;
    hash?: string;
  }> = [
    {
      rawKey: "cursor_agent_id",
      hashKey: "cursor_agent_id_hash",
      raw: markers.cursorAgentId,
      hash: markers.cursorAgentIdHash,
    },
    {
      rawKey: "cursor_run_id",
      hashKey: "cursor_run_id_hash",
      raw: markers.cursorRunId,
      hash: markers.cursorRunIdHash,
    },
    {
      rawKey: "builder_agent_id",
      hashKey: "builder_agent_id_hash",
      raw: markers.builderAgentId,
      hash: markers.builderAgentIdHash,
    },
    {
      rawKey: "previous_builder_agent_id",
      hashKey: "previous_builder_agent_id_hash",
      raw: markers.previousBuilderAgentId,
      hash: markers.previousBuilderAgentIdHash,
    },
  ];

  for (const { rawKey, hashKey, raw, hash } of pairs) {
    if (raw !== undefined && hash !== undefined && hashProviderIdentity(raw) !== hash) {
      throw new HarnessMarkerParseError(
        "conflicting_identity_markers",
        `Marker "${rawKey}" and "${hashKey}" are inconsistent.`,
      );
    }
  }
}

function parseHarnessMarkerLines(block: string): HarnessMarkers {
  const markers: HarnessMarkers = {};
  const seenKeys = new Map<string, string>();

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      if (trimmed.startsWith("harness-orchestrator")) {
        markers.orchestratorMarker = trimmed;
      }
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (IDENTITY_HASH_MARKER_KEYS.has(key)) {
      assertIdentityHashMarker(key, value);
    }
    recordMarkerKey(seenKeys, key, value);

    switch (key) {
      case "phase":
        markers.phase = value;
        break;
      case "run_id":
        markers.runId = value;
        break;
      case "cursor_agent_id":
        markers.cursorAgentId = value;
        break;
      case "cursor_agent_id_hash":
        markers.cursorAgentIdHash = value;
        break;
      case "cursor_run_id":
        markers.cursorRunId = value;
        break;
      case "cursor_run_id_hash":
        markers.cursorRunIdHash = value;
        break;
      case "builder_agent_id":
        markers.builderAgentId = value;
        break;
      case "builder_agent_id_hash":
        markers.builderAgentIdHash = value;
        break;
      case "builder_thread_generation":
        markers.builderThreadGeneration = value;
        break;
      case "builder_thread_action":
        markers.builderThreadAction = value;
        break;
      case "builder_origin_run_id":
        markers.builderOriginRunId = value;
        break;
      case "builder_thread_idempotency_key":
        markers.builderThreadIdempotencyKey = value;
        break;
      case "previous_builder_agent_id":
        markers.previousBuilderAgentId = value;
        break;
      case "previous_builder_agent_id_hash":
        markers.previousBuilderAgentIdHash = value;
        break;
      case "builder_thread_replacement_reason":
        markers.builderThreadReplacementReason = value;
        break;
      case "model":
        markers.model = value;
        break;
      case "prompt_version":
        markers.promptVersion = value;
        break;
      case "target_repo":
        markers.targetRepo = value;
        break;
      case "base_branch":
        markers.baseBranch = value;
        break;
      case "branch":
        markers.branch = value;
        break;
      case "pr_url":
        markers.prUrl = value;
        break;
      case "preview_url":
        markers.previewUrl = value;
        break;
      case "previous_implementation_run_id":
        markers.previousImplementationRunId = value;
        break;
      case "previous_handoff_run_id":
        markers.previousHandoffRunId = value;
        break;
      case "pm_feedback_comment_id":
        markers.pmFeedbackCommentId = value;
        break;
      case "previous_revision_run_id":
        markers.previousRevisionRunId = value;
        break;
      case "merge_commit_sha":
        markers.mergeCommitSha = value;
        break;
      case "deployment_url":
        markers.deploymentUrl = value;
        break;
      case "github_actions_run_url":
        markers.githubActionsRunUrl = value;
        break;
      case "issue_key":
        markers.issueKey = value;
        break;
      case "pr_number":
        markers.prNumber = value;
        break;
      case "production_branch":
        markers.productionBranch = value;
        break;
      case "integration_success_status":
        markers.integrationSuccessStatus = value;
        break;
      case "production_head_sha":
        markers.productionHeadSha = value;
        break;
      case "previous_merge_run_id":
        markers.previousMergeRunId = value;
        break;
      case "promotion_proof_method":
        markers.promotionProofMethod = value;
        break;
      case "production_completion_id":
        markers.productionCompletionId = value;
        break;
      case "production_effect_id":
        markers.productionEffectId = value;
        break;
      case "repair_attempt":
        markers.repairAttempt = value;
        break;
      case "repair_path":
        markers.repairPath = value;
        break;
      case "trigger_reason":
        markers.triggerReason = value;
        break;
      case "conflict_files":
        markers.conflictFiles = value;
        break;
      case "dependency_closure_files":
        markers.dependencyClosureFiles = value;
        break;
      case "touched_files":
        markers.touchedFiles = value;
        break;
      case "repair_cycle_id":
        markers.repairCycleId = value;
        break;
      case "execution_environment":
        markers.executionEnvironment = value;
        break;
      case "execution_environment_marker":
        markers.executionEnvironmentMarker = value;
        break;
      case "hostname":
        markers.hostname = value;
        break;
      case "codespace_name":
        markers.codespaceName = value;
        break;
      case "github_run_id":
        markers.githubRunId = value;
        break;
      case "github_workflow":
        markers.githubWorkflow = value;
        break;
      case "git_branch":
        markers.gitBranch = value;
        break;
      case "git_sha":
        markers.gitSha = value;
        break;
      case "plan_generation_id":
        markers.planGenerationId = value;
        break;
      case "plan_artifact_hash":
        markers.planArtifactHash = value;
        break;
      case "implementation_generation_id":
        markers.implementationGenerationId = value;
        break;
      case "pr_head_sha":
        markers.prHeadSha = value;
        break;
      case "pr_base_sha":
        markers.prBaseSha = value;
        break;
      case "diff_hash":
        markers.diffHash = value;
        break;
      case "handoff_subject_identity":
        markers.handoffSubjectIdentity = value;
        break;
      case "review_subject_identity":
        markers.reviewSubjectIdentity = value;
        break;
      case "decision_identity":
        markers.decisionIdentity = value;
        break;
      default:
        if (trimmed.startsWith("harness-orchestrator")) {
          markers.orchestratorMarker = trimmed;
        }
        break;
    }
  }

  if (block.includes("harness-orchestrator-v1") && !markers.orchestratorMarker) {
    markers.orchestratorMarker = "harness-orchestrator-v1";
  }

  assertIdentityMarkerConsistency(markers);

  return markers;
}

function parseLegacyVisibleFooter(commentBody: string): HarnessMarkers {
  const segments = commentBody.split(/\n---\n/);
  const footerSegment =
    [...segments]
      .reverse()
      .find(
        (segment) =>
          segment.includes("harness-orchestrator-v1") ||
          /\nphase:\s*\S+/m.test(segment) ||
          /^phase:\s*\S+/m.test(segment),
      ) ?? segments.at(-1) ?? commentBody;

  return parseHarnessMarkerLines(footerSegment);
}

export function parseHarnessMarkersStrict(commentBody: string): HarnessMarkers {
  const htmlBlock = extractHarnessMetadataBlock(commentBody);
  if (htmlBlock) {
    return parseHarnessMarkerLines(htmlBlock);
  }
  return parseLegacyVisibleFooter(commentBody);
}

/** Fail-closed marker parsing; throws {@link HarnessMarkerParseError} on invalid hash markers. */
export function parseHarnessMarkers(commentBody: string): HarnessMarkers {
  return parseHarnessMarkersStrict(commentBody);
}
