import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatCommitLink,
  formatMarkdownLink,
  formatPullRequestLink,
} from "../github/links.js";
import type { ResolvedPreviewLinks } from "../preview/urls.js";
import { HarnessMarkerParseError, parseHarnessMarkers } from "./markers.js";
import { toPublicProviderIdentityHashes } from "./provider-identity-public.js";
import {
  buildHarnessComment,
  buildMinimalHarnessComment,
  formatBulletList,
  formatLinksAsMarkdown,
  type HarnessCommentLink,
} from "./comment-card.js";
import {
  formatHarnessErrorPhaseLabel,
  formatHarnessErrorReason,
  getCompletionLabel,
  getPhaseStartLabel,
  type HarnessErrorPhase,
  type PhaseStartPhase,
} from "./phase-labels.js";
import { appendExecutionEnvironmentMetadataLines } from "../runner/execution-environment.js";
import type { BuilderThreadMarkerEvidence } from "../runner/builder-thread-types.js";

export type { PhaseStartPhase, HarnessErrorPhase };

export interface HarnessCommentFooterInput {
  orchestratorMarker: string;
  phase: string;
  runId: string;
  cursorAgentIdHash?: string;
  cursorRunIdHash?: string;
  builderAgentIdHash?: string;
  builderThreadGeneration?: number;
  builderThreadAction?: string;
  builderOriginRunId?: string;
  builderThreadIdempotencyKey?: string;
  previousBuilderAgentIdHash?: string;
  builderThreadReplacementReason?: string;
  model: string;
  promptVersion: string;
  targetRepo: string;
  baseBranch?: string;
  /** Durable Plan Review correlation — written on planning completion comments. */
  planGenerationId?: string;
  planArtifactHash?: string;
}

export interface HandoffCommentFooterInput extends HarnessCommentFooterInput {
  branch?: string;
  prUrl?: string;
  previewUrl?: string;
  previousImplementationRunId?: string;
  /** Durable Code Review correlation — written on handoff completion comments. */
  implementationGenerationId?: string;
  prNumber?: string;
  prHeadSha?: string;
  prBaseSha?: string;
  diffHash?: string;
  /** Deterministic handoff subject for idempotent skip across jobs. */
  handoffSubjectIdentity?: string;
}

export interface RevisionCommentFooterInput extends HandoffCommentFooterInput {
  previousHandoffRunId?: string;
  pmFeedbackCommentId?: string;
}

export interface MergeCommentFooterInput extends RevisionCommentFooterInput {
  previousRevisionRunId?: string;
  mergeCommitSha?: string;
  deploymentUrl?: string;
  githubActionsRunUrl?: string;
  issueKey?: string;
  prNumber?: string;
  productionBranch?: string;
  integrationSuccessStatus?: string;
  repairAttempt?: string;
  repairPath?: string;
  triggerReason?: string;
  conflictFiles?: string;
  dependencyClosureFiles?: string;
  touchedFiles?: string;
  repairCycleId?: string;
}

export interface ProductionSyncCommentFooterInput extends MergeCommentFooterInput {
  productionHeadSha?: string;
  previousMergeRunId?: string;
  promotionProofMethod?: string;
  productionCompletionId?: string;
  productionEffectId?: string;
}

export interface PhaseStartCommentFooterInput extends HarnessCommentFooterInput {
  phase: PhaseStartPhase;
  branch?: string;
  prUrl?: string;
  githubActionsRunUrl?: string;
}

function tryParseHarnessMarkers(
  commentBody: string,
): ReturnType<typeof parseHarnessMarkers> | null {
  try {
    return parseHarnessMarkers(commentBody);
  } catch (error) {
    if (error instanceof HarnessMarkerParseError) {
      return null;
    }
    throw error;
  }
}

export function isHarnessOrchestratorComment(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    Boolean(markers.phase) &&
    Boolean(markers.runId)
  );
}

export function formatHarnessCommentFooter(
  input: ProductionSyncCommentFooterInput,
): string {
  const lines = buildHarnessMetadataLines(input);
  return `<!--\n${lines.join("\n")}\n-->`;
}

/** Alias for machine-readable metadata hidden from Linear UI. */
export const formatHarnessHiddenMetadata = formatHarnessCommentFooter;

function buildHarnessMetadataLines(
  input: ProductionSyncCommentFooterInput,
): string[] {
  const lines = [
    input.orchestratorMarker,
    `phase: ${input.phase}`,
    `run_id: ${input.runId}`,
  ];
  if (input.cursorAgentIdHash) {
    lines.push(`cursor_agent_id_hash: ${input.cursorAgentIdHash}`);
  }
  if (input.cursorRunIdHash) {
    lines.push(`cursor_run_id_hash: ${input.cursorRunIdHash}`);
  }
  if (input.builderAgentIdHash) {
    lines.push(`builder_agent_id_hash: ${input.builderAgentIdHash}`);
  }
  if (input.builderThreadGeneration !== undefined) {
    lines.push(`builder_thread_generation: ${input.builderThreadGeneration}`);
  }
  if (input.builderThreadAction) {
    lines.push(`builder_thread_action: ${input.builderThreadAction}`);
  }
  if (input.builderOriginRunId) {
    lines.push(`builder_origin_run_id: ${input.builderOriginRunId}`);
  }
  if (input.builderThreadIdempotencyKey) {
    lines.push(`builder_thread_idempotency_key: ${input.builderThreadIdempotencyKey}`);
  }
  if (input.previousBuilderAgentIdHash) {
    lines.push(
      `previous_builder_agent_id_hash: ${input.previousBuilderAgentIdHash}`,
    );
  }
  if (input.builderThreadReplacementReason) {
    lines.push(
      `builder_thread_replacement_reason: ${input.builderThreadReplacementReason}`,
    );
  }
  lines.push(
    `model: ${input.model}`,
    `prompt_version: ${input.promptVersion}`,
    `target_repo: ${input.targetRepo}`,
  );
  if (input.planGenerationId) {
    lines.push(`plan_generation_id: ${input.planGenerationId}`);
  }
  if (input.planArtifactHash) {
    lines.push(`plan_artifact_hash: ${input.planArtifactHash}`);
  }
  if (input.issueKey) {
    lines.push(`issue_key: ${input.issueKey}`);
  }
  if (input.baseBranch) {
    lines.push(`base_branch: ${input.baseBranch}`);
  }
  if (input.productionBranch) {
    lines.push(`production_branch: ${input.productionBranch}`);
  }
  if (input.integrationSuccessStatus) {
    lines.push(`integration_success_status: ${input.integrationSuccessStatus}`);
  }
  if (input.branch) {
    lines.push(`branch: ${input.branch}`);
  }
  if (input.prUrl) {
    lines.push(`pr_url: ${input.prUrl}`);
  }
  if (input.prNumber) {
    lines.push(`pr_number: ${input.prNumber}`);
  }
  if (input.implementationGenerationId) {
    lines.push(
      `implementation_generation_id: ${input.implementationGenerationId}`,
    );
  }
  if (input.prHeadSha) {
    lines.push(`pr_head_sha: ${input.prHeadSha}`);
  }
  if (input.prBaseSha) {
    lines.push(`pr_base_sha: ${input.prBaseSha}`);
  }
  if (input.diffHash) {
    lines.push(`diff_hash: ${input.diffHash}`);
  }
  if (input.handoffSubjectIdentity) {
    lines.push(`handoff_subject_identity: ${input.handoffSubjectIdentity}`);
  }
  if (input.previewUrl) {
    lines.push(`preview_url: ${input.previewUrl}`);
  }
  if (input.previousImplementationRunId) {
    lines.push(
      `previous_implementation_run_id: ${input.previousImplementationRunId}`,
    );
  }
  if (input.previousHandoffRunId) {
    lines.push(`previous_handoff_run_id: ${input.previousHandoffRunId}`);
  }
  if (input.pmFeedbackCommentId) {
    lines.push(`pm_feedback_comment_id: ${input.pmFeedbackCommentId}`);
  }
  if (input.previousRevisionRunId) {
    lines.push(`previous_revision_run_id: ${input.previousRevisionRunId}`);
  }
  if (input.previousMergeRunId) {
    lines.push(`previous_merge_run_id: ${input.previousMergeRunId}`);
  }
  if (input.mergeCommitSha) {
    lines.push(`merge_commit_sha: ${input.mergeCommitSha}`);
  }
  if (input.productionHeadSha) {
    lines.push(`production_head_sha: ${input.productionHeadSha}`);
  }
  if (input.promotionProofMethod) {
    lines.push(`promotion_proof_method: ${input.promotionProofMethod}`);
  }
  if (input.productionCompletionId) {
    lines.push(`production_completion_id: ${input.productionCompletionId}`);
  }
  if (input.productionEffectId) {
    lines.push(`production_effect_id: ${input.productionEffectId}`);
  }
  if (input.deploymentUrl) {
    lines.push(`deployment_url: ${input.deploymentUrl}`);
  }
  if (input.githubActionsRunUrl) {
    lines.push(`github_actions_run_url: ${input.githubActionsRunUrl}`);
  }
  if (input.repairAttempt) {
    lines.push(`repair_attempt: ${input.repairAttempt}`);
  }
  if (input.repairPath) {
    lines.push(`repair_path: ${input.repairPath}`);
  }
  if (input.triggerReason) {
    lines.push(`trigger_reason: ${input.triggerReason}`);
  }
  if (input.conflictFiles) {
    lines.push(`conflict_files: ${input.conflictFiles}`);
  }
  if (input.dependencyClosureFiles) {
    lines.push(`dependency_closure_files: ${input.dependencyClosureFiles}`);
  }
  if (input.touchedFiles) {
    lines.push(`touched_files: ${input.touchedFiles}`);
  }
  if (input.repairCycleId) {
    lines.push(`repair_cycle_id: ${input.repairCycleId}`);
  }
  return appendExecutionEnvironmentMetadataLines(lines);
}

function summarizeAgentText(text: string, maxLength = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trim()}…`;
}

function buildGithubActionsLink(
  githubActionsRunUrl?: string | null,
): HarnessCommentLink[] {
  if (!githubActionsRunUrl) {
    return [];
  }
  return [{ label: "GitHub Actions run", url: githubActionsRunUrl }];
}

export function formatPlanningComment(
  planBody: string,
  footer: HarnessCommentFooterInput,
  options?: { planReviewNext?: boolean; planningOnlyTerminal?: boolean },
): string {
  const summary = summarizeAgentText(planBody);
  const nextStep = options?.planningOnlyTerminal
    ? "This was a planning-only execution; implementation was not started. The issue is being placed in the terminal canary status (**Canceled**)."
    : options?.planReviewNext
      ? "Plan Review will start automatically. No PM action is needed until the issue reaches **PM Review**."
      : "Implementation will start automatically. No PM action is needed until the issue reaches **PM Review**.";
  return buildHarnessComment({
    phaseLabel: getCompletionLabel("planning"),
    pmSection: [
      "Planning is complete.",
      "",
      summary || "_No plan summary reported._",
      "",
      nextStep,
    ],
    engineerSection: [
      ...formatBulletList([
        `Target repo: ${footer.targetRepo}`,
        footer.baseBranch ? `Base branch: \`${footer.baseBranch}\`` : "",
        `Harness run ID: ${footer.runId}`,
      ]).filter(Boolean),
      "",
      "### Full plan",
      planBody.trim() || "_No plan body reported._",
    ],
    footer: formatHarnessCommentFooter(footer),
  });
}

export function hasPlanningCompletionMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "planning" &&
    Boolean(markers.runId)
  );
}

export function hasHandoffCompletionMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "handoff" &&
    Boolean(markers.runId) &&
    Boolean(markers.prUrl)
  );
}

export function hasRevisionCompletionMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "revision" &&
    Boolean(markers.runId) &&
    Boolean(markers.prUrl) &&
    Boolean(markers.pmFeedbackCommentId)
  );
}

export function findRevisionMarkerForPmFeedback(
  comments: { body: string }[],
  orchestratorMarker: string,
  pmFeedbackCommentId: string,
): boolean {
  return comments.some((comment) => {
    const markers = tryParseHarnessMarkers(comment.body);
    if (!markers) {
      return false;
    }
    return (
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === "revision" &&
      markers.pmFeedbackCommentId === pmFeedbackCommentId
    );
  });
}

const MAX_CHANGED_FILES_IN_COMMENT = 30;

function formatChangedFiles(changedFiles: string[]): string[] {
  const files = changedFiles.slice(0, MAX_CHANGED_FILES_IN_COMMENT);
  const lines = files.length > 0 ? files.map((file) => `- ${file}`) : ["- _none reported_"];
  if (changedFiles.length > MAX_CHANGED_FILES_IN_COMMENT) {
    lines.push(
      `- … and ${changedFiles.length - MAX_CHANGED_FILES_IN_COMMENT} more (see github/pr.json)`,
    );
  }
  return lines;
}

export interface HandoffCommentBodyInput {
  prTitle: string;
  prUrl: string;
  branch: string;
  targetRepo: string;
  baseBranch?: string;
  previewUrl: string | null;
  previewWarning: string | null;
  changedFiles: string[];
  checkSummary: string;
  harnessRunId: string;
  previousImplementationRunId: string | null;
  changeSummary?: string;
}

/** Informational post-build comment when automated Code Review will run next. */
export function buildBuildCompleteCommentBody(
  input: HandoffCommentBodyInput,
): string {
  const links: HarnessCommentLink[] = [{ label: "Pull request", url: input.prUrl }];
  if (input.previewUrl) {
    links.unshift({ label: "Preview deployment", url: input.previewUrl });
  }

  const pmSection = [
    "Build complete. Automated Code Review is starting for this pull request.",
    "",
    ...formatLinksAsMarkdown(links),
    "",
    "You do not need to approve the preview until automated Code Review finishes and posts the review request.",
  ];
  if (input.previewWarning) {
    pmSection.push("", input.previewWarning);
  }

  return buildHarnessComment({
    phaseLabel: getCompletionLabel("build_complete"),
    pmSection,
    engineerSection: [
      ...formatBulletList([
        `Target repo: ${input.targetRepo}`,
        input.baseBranch ? `Base branch: \`${input.baseBranch}\`` : "",
        `Branch: \`${input.branch}\``,
        `Harness run ID: ${input.harnessRunId}`,
      ]).filter(Boolean),
      "",
      "### Changed files",
      ...formatChangedFiles(input.changedFiles),
      "",
      "### Checks",
      input.checkSummary,
    ],
    footer: "",
  });
}

export function buildPmHandoffMarker(subjectIdentity: string): string {
  return `<!-- p-dev-pm-handoff:${subjectIdentity} -->`;
}

export function hasPmHandoffMarker(
  commentBody: string,
  subjectIdentity: string,
): boolean {
  return commentBody.includes(buildPmHandoffMarker(subjectIdentity));
}

export function buildHandoffCommentBody(input: HandoffCommentBodyInput & {
  subjectIdentity?: string;
}): string {
  const links: HarnessCommentLink[] = [{ label: "Pull request", url: input.prUrl }];
  if (input.previewUrl) {
    links.unshift({ label: "Preview deployment", url: input.previewUrl });
  }

  const pmSection = [
    "The build is ready for your review.",
    "",
    ...formatLinksAsMarkdown(links),
    "",
    input.changeSummary
      ? input.changeSummary
      : "Review the preview and PR against the acceptance criteria in this issue.",
    "",
    "Move the issue to **Needs Revision** with feedback, or to **Ready to Merge** when you accept the change.",
  ];
  if (input.previewWarning) {
    pmSection.push("", input.previewWarning);
  }

  const marker = input.subjectIdentity
    ? `${buildPmHandoffMarker(input.subjectIdentity)}\n`
    : "";

  return `${marker}${buildHarnessComment({
    phaseLabel: getCompletionLabel("handoff"),
    pmSection,
    engineerSection: [
      ...formatBulletList([
        `Target repo: ${input.targetRepo}`,
        input.baseBranch ? `Base branch: \`${input.baseBranch}\`` : "",
        `Branch: \`${input.branch}\``,
        `Harness run ID: ${input.harnessRunId}`,
        input.previousImplementationRunId
          ? `Previous implementation run ID: ${input.previousImplementationRunId}`
          : "",
      ]).filter(Boolean),
      "",
      "### Changed files",
      ...formatChangedFiles(input.changedFiles),
      "",
      "### Checks",
      input.checkSummary,
    ],
    footer: "",
  })}`;
}

export function formatHandoffComment(
  body: string,
  footer: HandoffCommentFooterInput,
): string {
  return `${body.trim()}\n\n${formatHarnessCommentFooter(footer)}`;
}

export interface RevisionCommentBodyInput {
  summary: string;
  prUrl: string;
  branch: string;
  targetRepo: string;
  baseBranch?: string;
  previewUrl: string | null;
  previewWarning: string | null;
  changedFiles: string[];
  checkSummary: string;
  validationSummary: string;
  harnessRunId: string;
  previousHandoffRunId: string | null;
  pmFeedbackCommentId: string;
}

export function buildRevisionCommentBody(input: RevisionCommentBodyInput): string {
  const links: HarnessCommentLink[] = [{ label: "Pull request", url: input.prUrl }];
  if (input.previewUrl) {
    links.unshift({ label: "Preview deployment", url: input.previewUrl });
  }

  const pmSection = [
    "Revision finished and the pull request was updated.",
    "",
    ...formatLinksAsMarkdown(links),
    "",
    summarizeAgentText(input.summary) || "Review the updated preview and PR diff.",
  ];
  if (input.previewWarning) {
    pmSection.push("", input.previewWarning);
  }

  return buildHarnessComment({
    phaseLabel: getCompletionLabel("revision"),
    pmSection,
    engineerSection: [
      ...formatBulletList([
        `Target repo: ${input.targetRepo}`,
        input.baseBranch ? `Base branch: \`${input.baseBranch}\`` : "",
        `Branch: \`${input.branch}\``,
        `Harness run ID: ${input.harnessRunId}`,
        `PM feedback comment ID: ${input.pmFeedbackCommentId}`,
        input.previousHandoffRunId
          ? `Previous handoff run ID: ${input.previousHandoffRunId}`
          : "",
      ]).filter(Boolean),
      "",
      "### Changed files",
      ...formatChangedFiles(input.changedFiles),
      "",
      "### Checks",
      input.checkSummary,
      "",
      "### Validation",
      input.validationSummary.trim() || "_No validation summary reported._",
    ],
    footer: "",
  }).replace(/\n\n$/, "");
}

export function formatRevisionComment(
  body: string,
  footer: RevisionCommentFooterInput,
): string {
  return `${body.trim()}\n\n${formatHarnessCommentFooter(footer)}`;
}

export function hasMergeCompletionMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "merge" &&
    Boolean(markers.runId) &&
    Boolean(markers.prUrl)
  );
}

export function hasProductionSyncMarker(
  commentBody: string,
  orchestratorMarker: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === "production_sync" &&
    Boolean(markers.runId)
  );
}

export function findMergeMarkerForPrUrl(
  comments: { body: string }[],
  orchestratorMarker: string,
  prUrl: string,
): boolean {
  const normalized = prUrl.trim().toLowerCase();
  return comments.some((comment) => {
    const markers = tryParseHarnessMarkers(comment.body);
    if (!markers) {
      return false;
    }
    return (
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === "merge" &&
      Boolean(markers.runId) &&
      markers.prUrl?.trim().toLowerCase() === normalized
    );
  });
}

export function findLatestMergeMarker(
  comments: { body: string; createdAt?: string }[],
  orchestratorMarker: string,
): { body: string; markers: ReturnType<typeof parseHarnessMarkers> } | null {
  const mergeComments = comments
    .map((comment) => ({
      comment,
      markers: tryParseHarnessMarkers(comment.body),
    }))
    .filter(
      (
        entry,
      ): entry is {
        comment: { body: string; createdAt?: string };
        markers: NonNullable<ReturnType<typeof tryParseHarnessMarkers>>;
      } =>
        entry.markers !== null &&
        entry.markers.orchestratorMarker === orchestratorMarker &&
        entry.markers.phase === "merge" &&
        Boolean(entry.markers.runId),
    );

  mergeComments.sort((a, b) => {
    const aTime = a.comment.createdAt ? Date.parse(a.comment.createdAt) : 0;
    const bTime = b.comment.createdAt ? Date.parse(b.comment.createdAt) : 0;
    return bTime - aTime;
  });

  const latest = mergeComments[0];
  if (!latest) {
    return null;
  }
  return { body: latest.comment.body, markers: latest.markers };
}

export function findProductionSyncMarkerForMergeCommit(
  comments: { body: string }[],
  orchestratorMarker: string,
  mergeCommitSha: string,
): boolean {
  const normalized = mergeCommitSha.trim().toLowerCase();
  return comments.some((comment) => {
    const markers = tryParseHarnessMarkers(comment.body);
    if (!markers) {
      return false;
    }
    return (
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === "production_sync" &&
      Boolean(markers.runId) &&
      markers.mergeCommitSha?.trim().toLowerCase() === normalized
    );
  });
}

export interface AdoptableProductionSyncCommentMatch {
  body: string;
  markers: ReturnType<typeof parseHarnessMarkers>;
  matchKind: "production_effect_id" | "production_completion_id" | "legacy_tuple";
}

/**
 * Find a production-sync comment that can satisfy linear_production_comment
 * for the current completion without posting a duplicate.
 */
export function findAdoptableProductionSyncComment(input: {
  comments: { body: string }[];
  orchestratorMarker: string;
  productionCompletionId: string;
  productionEffectId: string;
  issueKey: string;
  targetRepository: string;
  mergeToDevSha: string;
  productionBranch: string;
}): AdoptableProductionSyncCommentMatch | null {
  const mergeSha = input.mergeToDevSha.trim().toLowerCase();
  const issueKey = input.issueKey.trim().toUpperCase();
  const targetRepo = input.targetRepository.trim().toLowerCase();
  const productionBranch = input.productionBranch.trim();

  for (const comment of input.comments) {
    const markers = tryParseHarnessMarkers(comment.body);
    if (
      !markers ||
      markers.orchestratorMarker !== input.orchestratorMarker ||
      markers.phase !== "production_sync" ||
      !markers.runId
    ) {
      continue;
    }

    if (
      markers.productionEffectId &&
      markers.productionEffectId === input.productionEffectId
    ) {
      return {
        body: comment.body,
        markers,
        matchKind: "production_effect_id",
      };
    }

    if (
      markers.productionCompletionId &&
      markers.productionCompletionId === input.productionCompletionId
    ) {
      return {
        body: comment.body,
        markers,
        matchKind: "production_completion_id",
      };
    }

    const markerMerge = markers.mergeCommitSha?.trim().toLowerCase();
    const markerIssue = markers.issueKey?.trim().toUpperCase();
    const markerRepo = markers.targetRepo?.trim().toLowerCase();
    const markerBranch = markers.productionBranch?.trim();
    if (
      markerMerge === mergeSha &&
      markerIssue === issueKey &&
      markerRepo === targetRepo &&
      markerBranch === productionBranch
    ) {
      return {
        body: comment.body,
        markers,
        matchKind: "legacy_tuple",
      };
    }
  }

  return null;
}

export interface MergeCompletionCommentBodyInput {
  prUrl: string;
  branch: string;
  targetRepo: string;
  mergeMethod: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  baseBranch: string;
  productionBranch: string;
  previewLinks: ResolvedPreviewLinks;
  deploymentWarning: string | null;
  changedFiles: string[];
  checkSummary: string;
  finalIssueStatus: string;
  harnessRunId: string;
  previousHandoffRunId: string | null;
  previousRevisionRunId: string | null;
}

export function buildMergeCompletionCommentBody(
  input: MergeCompletionCommentBodyInput,
): string {
  const links: HarnessCommentLink[] = [
    { label: "Pull request", url: input.prUrl },
  ];
  if (input.previewLinks.integrationPreviewUrl) {
    links.push({
      label: "Dev preview",
      url: input.previewLinks.integrationPreviewUrl,
    });
  }
  if (input.previewLinks.productionUrl) {
    links.push({
      label: "Production",
      url: input.previewLinks.productionUrl,
    });
  }

  const pmSection = [
    input.previewLinks.notYetInProduction
      ? `This change reached **${input.baseBranch}** (dev) and is **not yet in production**.`
      : `This change reached **${input.baseBranch}**.`,
    "",
    ...formatLinksAsMarkdown(links),
    "",
    `Linear status: **${input.finalIssueStatus}**.`,
  ];

  const deploymentLines: string[] = [];
  if (input.previewLinks.integrationPreviewUrl) {
    deploymentLines.push(
      formatMarkdownLink("Dev preview", input.previewLinks.integrationPreviewUrl),
    );
  }
  if (input.previewLinks.productionUrl) {
    deploymentLines.push(
      formatMarkdownLink("Production", input.previewLinks.productionUrl),
    );
  } else if (input.deploymentWarning) {
    deploymentLines.push(input.deploymentWarning);
  } else if (input.previewLinks.mergedToProduction) {
    deploymentLines.push("_Production deployment URL not captured_");
  }

  return buildHarnessComment({
    phaseLabel: getCompletionLabel("merge"),
    pmSection,
    engineerSection: [
      ...formatBulletList([
        `Target repo: ${input.targetRepo}`,
        `Branch: \`${input.branch}\``,
        `Base branch: \`${input.baseBranch}\``,
        `Production branch: \`${input.productionBranch}\``,
        `Merge method: ${input.mergeMethod}`,
        input.mergeCommitSha
          ? `Merge commit: ${formatCommitLink(input.targetRepo, input.mergeCommitSha)}`
          : "",
        input.mergedAt ? `Merged at: ${input.mergedAt}` : "",
        `Harness run ID: ${input.harnessRunId}`,
        input.previousRevisionRunId
          ? `Previous revision run ID: ${input.previousRevisionRunId}`
          : "",
        input.previousHandoffRunId
          ? `Previous handoff run ID: ${input.previousHandoffRunId}`
          : "",
      ]).filter(Boolean),
      "",
      "### Deployment",
      ...(deploymentLines.length > 0 ? deploymentLines : ["- _No deployment links captured_"]),
      "",
      "### Changed files",
      ...formatChangedFiles(input.changedFiles),
      "",
      "### Checks",
      input.checkSummary,
    ],
    footer: "",
  }).replace(/\n\n$/, "");
}

export interface ProductionPromotionCommentBodyInput {
  prUrl: string;
  branch: string;
  targetRepo: string;
  baseBranch: string;
  productionBranch: string;
  mergeCommitSha: string;
  productionHeadSha: string;
  productionUrl: string | null;
  harnessRunId: string;
  previousMergeRunId: string | null;
  promotionProofMethod: string;
}

export function buildProductionPromotionCommentBody(
  input: ProductionPromotionCommentBodyInput,
): string {
  const links: HarnessCommentLink[] = [];
  if (input.productionUrl) {
    links.push({ label: "Production", url: input.productionUrl });
  }
  links.push({ label: "Pull request", url: input.prUrl });

  return buildHarnessComment({
    phaseLabel: getCompletionLabel("production_sync"),
    pmSection: [
      "This issue reached **production**.",
      "",
      ...formatLinksAsMarkdown(links),
      "",
      input.productionUrl
        ? `Live site: ${formatMarkdownLink("Production", input.productionUrl)}`
        : "_Production URL not captured — check your deployment provider._",
    ],
    engineerSection: formatBulletList([
      `Target repo: ${input.targetRepo}`,
      `Dev branch: \`${input.baseBranch}\``,
      `Production branch: \`${input.productionBranch}\``,
      `PR: ${formatPullRequestLink(input.prUrl)}`,
      `Merge commit: ${formatCommitLink(input.targetRepo, input.mergeCommitSha)}`,
      `Production commit: ${formatCommitLink(input.targetRepo, input.productionHeadSha)}`,
      `Promotion proof: ${input.promotionProofMethod}`,
      `Harness run ID: ${input.harnessRunId}`,
      input.previousMergeRunId
        ? `Previous merge run ID: ${input.previousMergeRunId}`
        : "",
    ]).filter(Boolean),
    footer: "",
  }).replace(/\n\n$/, "");
}

export function formatMergeComment(
  body: string,
  footer: MergeCommentFooterInput,
): string {
  return `${body.trim()}\n\n${formatHarnessCommentFooter(footer)}`;
}

export function formatProductionSyncComment(
  body: string,
  footer: ProductionSyncCommentFooterInput,
): string {
  return `${body.trim()}\n\n${formatHarnessCommentFooter(footer)}`;
}

export interface PhaseStartCommentBodyInput {
  issueKey: string;
  targetRepo: string;
  baseBranch?: string;
  branch?: string;
  prUrl?: string;
  githubActionsRunUrl?: string | null;
  harnessRunId?: string;
}

export function buildPhaseStartCommentBody(
  phase: PhaseStartPhase,
  input: PhaseStartCommentBodyInput,
): string {
  const label = getPhaseStartLabel(phase);

  if (phase === "implementation_start" || phase === "merge_start") {
    return buildMinimalHarnessComment({
      phaseLabel: label,
      links: buildGithubActionsLink(input.githubActionsRunUrl),
    }).replace(/\n\n$/, "");
  }

  const statusByPhase: Record<PhaseStartPhase, string> = {
    planning_start: "Planning has started.",
    plan_review_start: "Plan Review has started.",
    implementation_start: "Build has started.",
    code_review_start: "Code Review has started.",
    code_revision_start: "Code Revision has started.",
    revision_start: "Revision has started.",
    merge_start: "Merging has started.",
  };

  const links = buildGithubActionsLink(input.githubActionsRunUrl);

  const pmSection = [statusByPhase[phase], ""];
  if (links.length > 0) {
    pmSection.push(...formatLinksAsMarkdown(links), "");
  }

  return buildHarnessComment({
    phaseLabel: label,
    pmSection: pmSection.filter(Boolean),
    engineerSection: [],
    footer: "",
  }).replace(/\n\n$/, "");
}

export function formatPhaseStartComment(
  phase: PhaseStartPhase,
  bodyInput: PhaseStartCommentBodyInput,
  footer: Omit<PhaseStartCommentFooterInput, "phase">,
): string {
  const body = buildPhaseStartCommentBody(phase, {
    ...bodyInput,
    harnessRunId: footer.runId,
  });
  return `${body}\n\n${formatHarnessCommentFooter({ ...footer, phase })}`;
}

export function buildErrorCommentBody(
  phase: HarnessErrorPhase,
  message: string,
  input: {
    githubActionsRunUrl?: string | null;
    errorClassification?: string;
    targetRepo?: string;
    branch?: string;
    prUrl?: string;
    baseBranch?: string;
    harnessRunId?: string;
  },
): string {
  const links = buildGithubActionsLink(input.githubActionsRunUrl);
  const pmSection = [message.trim()];
  if (links.length > 0) {
    pmSection.push("", ...formatLinksAsMarkdown(links));
  }
  pmSection.push(
    "",
    "Check whether action is needed on your side, then retry or update the issue status.",
  );

  return buildHarnessComment({
    phaseLabel: formatHarnessErrorPhaseLabel(phase),
    outcomeLabel: "Error",
    reasonLabel: formatHarnessErrorReason(
      phase,
      message,
      input.errorClassification,
    ),
    pmSection,
    engineerSection: formatBulletList([
      input.errorClassification
        ? `Error classification: ${input.errorClassification}`
        : "",
      input.targetRepo ? `Target repo: ${input.targetRepo}` : "",
      input.baseBranch ? `Base branch: \`${input.baseBranch}\`` : "",
      input.branch ? `Branch: \`${input.branch}\`` : "",
      input.prUrl ? `PR: ${input.prUrl}` : "",
      input.harnessRunId ? `Harness run ID: ${input.harnessRunId}` : "",
    ]).filter(Boolean),
    footer: "",
  }).replace(/\n\n$/, "");
}

export function hasPhaseStartMarker(
  commentBody: string,
  orchestratorMarker: string,
  phase: PhaseStartPhase,
  runId: string,
): boolean {
  const markers = tryParseHarnessMarkers(commentBody);
  if (!markers) {
    return false;
  }
  return (
    markers.orchestratorMarker === orchestratorMarker &&
    markers.phase === phase &&
    markers.runId === runId
  );
}

export function findPhaseStartMarker(
  comments: { body: string }[],
  orchestratorMarker: string,
  phase: PhaseStartPhase,
  runId: string,
): boolean {
  return comments.some((comment) =>
    hasPhaseStartMarker(comment.body, orchestratorMarker, phase, runId),
  );
}

export function findLatestPhaseStartRunId(
  comments: { body: string }[],
  orchestratorMarker: string,
  phase: PhaseStartPhase,
): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment) {
      continue;
    }
    const markers = tryParseHarnessMarkers(comment.body);
    if (
      markers &&
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === phase &&
      markers.runId
    ) {
      return markers.runId;
    }
  }

  return null;
}

export async function writeCommentsArtifact(
  runDirectory: string,
  comments: string[],
): Promise<void> {
  const filePath = path.join(runDirectory, "linear", "comments-written.md");
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = comments.map((c, i) => `## Comment ${i + 1}\n\n${c}`).join("\n\n");
  await writeFile(filePath, `${content}\n`, "utf8");
}

export function parsePrNumberFromUrl(prUrl: string): string | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match?.[1] ?? null;
}

export function withBuilderThreadMarkerEvidence<
  T extends HarnessCommentFooterInput,
>(footer: T, evidence: BuilderThreadMarkerEvidence): T {
  const evidenceHashes = toPublicProviderIdentityHashes({
    builderAgentId: evidence.builderAgentId,
    previousBuilderAgentId: evidence.previousBuilderAgentId,
  });
  return {
    ...footer,
    builderAgentIdHash:
      evidenceHashes.builderAgentIdHash ?? footer.builderAgentIdHash,
    builderThreadGeneration:
      evidence.builderThreadGeneration ?? footer.builderThreadGeneration,
    builderThreadAction:
      evidence.builderThreadAction ?? footer.builderThreadAction,
    builderOriginRunId: evidence.builderOriginRunId ?? footer.builderOriginRunId,
    builderThreadIdempotencyKey:
      evidence.builderThreadIdempotencyKey ?? footer.builderThreadIdempotencyKey,
    previousBuilderAgentIdHash:
      evidenceHashes.previousBuilderAgentIdHash ??
      footer.previousBuilderAgentIdHash,
    builderThreadReplacementReason:
      evidence.builderThreadReplacementReason ??
      footer.builderThreadReplacementReason,
  };
}
