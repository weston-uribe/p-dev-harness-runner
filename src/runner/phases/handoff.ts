import { mkdir, writeFile } from "node:fs/promises";
import {
  DEFAULT_HANDOFF_ALLOW_PM_REVIEW_WITHOUT_PREVIEW,
  DEFAULT_PREVIEW_POLL_INTERVAL_SECONDS,
  DEFAULT_PREVIEW_POLL_TIMEOUT_SECONDS,
  HANDOFF_PROMPT_VERSION,
  MILESTONE,
} from "../../config/defaults.js";
import { resolveNextStatusName, applyPhaseTransition } from "../workflow-transition.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getGithubChecksPath,
  getGithubPrPath,
  getHandoffCommentPath,
  getImplementationCommentLoadedPath,
  getIssueSnapshotAfterPath,
  getVercelDeploymentPath,
} from "../../artifacts/paths.js";
import {
  buildBuildCompleteCommentBody,
  buildHandoffCommentBody,
  writeCommentsArtifact,
} from "../../linear/comments.js";
import {
  ensureCodeReviewJobDispatched,
  isCodeReviewDispatchProven,
  MISSING_DISPATCH_TOKEN_MESSAGE,
} from "../../workflow/code-review-dispatch-effect.js";
import { buildCodeReviewSubjectIdentity } from "../../workflow/subject-identities.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { findImplementationPullRequest } from "../../github/pr-discovery.js";
import {
  createLinearClient,
  listIssueComments,
  postErrorComment,
  postHandoffComment,
  transitionIssueStatus,
} from "../../linear/writer.js";
import { GitHubClient } from "../../github/client.js";
import { assertPrBaseBranchMatches } from "../../github/base-branch.js";
import {
  classifyGitHubError,
  inspectPullRequest,
} from "../../github/pr-inspector.js";
import { parsePrUrl } from "../../github/pr-url.js";
import { pollForVercelPreview } from "../../preview/vercel-from-pr.js";
import { shouldCaptureApplicationPreview } from "../../preview/preview-capability.js";
import { normalizeRepoUrl } from "../../resolver/normalize-repo.js";
import { resolveBuilderThreadMarkerEvidence } from "../builder-thread-lineage.js";
import { HandoffError } from "../errors.js";
import {
  classifyUnexpectedPhaseError,
  extractErrorMessage,
  isStaleEligibilitySkip,
} from "../classify-phase-error.js";
import { runPreflight } from "../preflight.js";
import {
  assertHandoffEligibleStatus,
  checkHandoffIdempotency,
} from "../idempotency.js";
import type { EventLogger } from "../../artifacts/events.js";
import type {
  ErrorClassification,
  FinalOutcome,
  RunManifest,
} from "../../types/run.js";
import type { ParsedIssue } from "../../types/parsed-issue.js";
import type { ResolvedTarget } from "../../resolver/target-repo.js";
import type {
  EvaluationRuntime,
  PhaseTraceHandle,
} from "../../evaluation/types.js";
import { categorizeCheckResult } from "../../evaluation/capture-policy.js";
import {
  finalizePhaseEvaluation,
  safeStartPhaseTrace,
} from "../../evaluation/phase-helpers.js";
import { resolveAuthoritativeLinearTeamIdFromConfig } from "../../config/resolve-linear-team.js";
import { listTeamWorkflowStates } from "../../setup/linear-setup-client.js";
import {
  evaluateCodeReviewReadiness,
} from "../../workflow/code-review-readiness.js";
import {
    loadOrBootstrapWorkflowState,
} from "../../workflow/state/index.js";
import { resolvePhaseWorkflowStateStore } from "../../workflow/state/resolve-store.js";
import { createImplementationArtifactIdentity } from "../../workflow/implementation-artifact.js";
import { buildHandoffSubjectIdentity } from "../../workflow/subject-identities.js";
import {
  buildSideEffectIdentity,
  isSideEffectCompleted,
  markSideEffectCompleted,
  upsertPendingSideEffect,
} from "../../workflow/state/side-effects.js";

export interface HandoffPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface HandoffPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new HandoffError(
      name === "LINEAR_API_KEY" ? "linear_auth_failure" : "github_auth_failure",
      `${name} is required for live handoff runs`,
    );
  }
  return value;
}

async function writeErrorArtifact(
  runDirectory: string,
  message: string,
  errorClassification: ErrorClassification,
): Promise<void> {
  await mkdir(`${runDirectory}/errors`, { recursive: true });
  await writeFile(
    `${runDirectory}/errors/error.json`,
    `${JSON.stringify({ message, errorClassification }, null, 2)}\n`,
    "utf8",
  );
}

async function writeFinalManifest(
  manifest: RunManifest,
  runDirectory: string,
  parsed: ParsedIssue,
  resolved: ResolvedTarget | null,
  events: EventLogger | null,
  finalOutcome: FinalOutcome,
  errorClassification: ErrorClassification,
  phaseTrace: PhaseTraceHandle | null = null,
  extraEvalMetadata?: Record<string, unknown>,
  evaluationRuntime: EvaluationRuntime | null = null,
): Promise<HandoffPhaseResult> {
  const finalManifest = await finalizePhaseEvaluation({
    runtime: evaluationRuntime,
    phaseTrace,
    manifest,
    runDirectory,
    extraMetadata: extraEvalMetadata,
  });

  if (runDirectory) {
    await writeManifest(runDirectory, finalManifest);
    await writeRunSummary(runDirectory, finalManifest, parsed, resolved);
    await events?.log("run_finished", finalOutcome === "success" ? "info" : "error", {
      finalOutcome,
      errorClassification,
    });
  }

  const exitCode =
    finalOutcome === "success" ||
    finalOutcome === "duplicate" ||
    finalOutcome === "skipped"
      ? 0
      : errorClassification &&
          [
            "ambiguous_issue",
            "missing_target_repo",
            "unknown_repo_denied",
            "wrong_status",
            "github_auth_failure",
            "configuration_error",
            "missing_implementation_marker",
            "missing_implementation_pr",
            "missing_pr_url",
            "base_branch_missing",
            "wrong_pr_base_branch",
          ].includes(errorClassification)
        ? 2
        : 3;

  return { manifest: finalManifest, runDirectory, exitCode };
}

export async function executeHandoffPhase(
  options: HandoffPhaseOptions,
): Promise<HandoffPhaseResult> {
  let linearApiKey: string;
  let githubToken: string;

  try {
    githubToken = requireEnv("GITHUB_TOKEN");
    linearApiKey = requireEnv("LINEAR_API_KEY");
  } catch (error) {
    if (error instanceof HandoffError) {
      const startedAt = new Date().toISOString();
      const runId = `auth-failure-${options.issueKey}`;
      const phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
        phase: "handoff",
        issueKey: options.issueKey,
        runId,
      });
      const manifest: RunManifest = {
        runId,
        issueKey: options.issueKey,
        phase: "handoff",
        phaseInferredFromStatus: null,
        linearStatusBefore: null,
        linearStatusAfter: null,
        targetRepo: null,
        baseBranch: null,
        resolutionSource: null,
        dryRun: false,
        finalOutcome: "failed",
        errorClassification: error.classification,
        startedAt,
        finishedAt: startedAt,
        milestone: MILESTONE,
        promptVersion: null,
        cursorAgentId: null,
        cursorRunId: null,
        branch: null,
        prUrl: null,
        previewUrl: null,
        validationSummary: null,
        changedFiles: null,
        checkSummary: null,
        previousImplementationRunId: null,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model: null,
      };
      return writeFinalManifest(
        manifest,
        "",
        {
          task: "",
          acceptanceCriteria: [],
          outOfScope: [],
          parseErrors: [],
        },
        null,
        null,
        "failed",
        error.classification,
        phaseTrace,
      );
    }
    throw error;
  }

  const preflight = await runPreflight({
    issueKey: options.issueKey,
    configPath: options.configPath,
    linearApiKey,
  });

  let phaseTrace: PhaseTraceHandle | null = null;

  if (!preflight.success) {
    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "handoff",
      issueKey: options.issueKey,
      runId: preflight.runId,
      metadata: {
        resolutionSource: preflight.resolved?.resolutionSource ?? null,
        baseBranch: preflight.resolved?.baseBranch ?? null,
        repositoryConfigurationId: preflight.resolved?.repoConfigId ?? null,
        linearStatusBefore: preflight.issue?.status ?? null,
      },
    });
    phaseTrace?.startChild("p-dev.preflight", "span")?.end({
      finalOutcome: "failed",
      errorClassification: preflight.errorClassification,
    });
    const manifest: RunManifest = {
      runId: preflight.runId,
      issueKey: options.issueKey,
      phase: "handoff",
      phaseInferredFromStatus: preflight.phaseInferredFromStatus,
      linearStatusBefore: preflight.issue?.status ?? null,
      linearStatusAfter: preflight.issue?.status ?? null,
      targetRepo: preflight.resolved?.targetRepo ?? null,
      baseBranch: preflight.resolved?.baseBranch ?? null,
      resolutionSource: preflight.resolved?.resolutionSource ?? null,
      dryRun: false,
      finalOutcome: "failed",
      errorClassification: preflight.errorClassification,
      startedAt: preflight.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      milestone: MILESTONE,
      promptVersion: null,
      cursorAgentId: null,
      cursorRunId: null,
      branch: null,
      prUrl: null,
      previewUrl: null,
      validationSummary: null,
      changedFiles: null,
      checkSummary: null,
      previousImplementationRunId: null,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model: null,
    };
    return writeFinalManifest(
      manifest,
      preflight.runDirectory,
      preflight.parsed,
      preflight.resolved,
      preflight.events,
      "failed",
      preflight.errorClassification,
      phaseTrace,
    );
  }

  const {
    config,
    issue,
    parsed,
    resolved,
    runId,
    runDirectory,
    events,
    phase,
    phaseInferredFromStatus,
    startedAt,
  } = preflight.context;

  phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
    phase: "handoff",
    issueKey: options.issueKey,
    runId,
    metadata: {
      resolutionSource: resolved.resolutionSource,
      baseBranch: resolved.baseBranch,
      repositoryConfigurationId: resolved.repoConfigId,
      linearStatusBefore: issue.status,
      promptContractVersion: HANDOFF_PROMPT_VERSION,
    },
  });
  phaseTrace?.startChild("p-dev.preflight", "span")?.end({
    finalOutcome: "success",
    resolutionSource: resolved.resolutionSource,
  });

  const linearStatusBefore = issue.status;
  let linearStatusAfter = issue.status;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = null;
  let branch: string | null = null;
  let prUrl: string | null = null;
  let previewUrl: string | null = null;
  let changedFiles: string[] | null = null;
  let checkSummary: string | null = null;
  let previousImplementationRunId: string | null = null;
  let enteredHandoff = false;
  const model = "";
  const commentsWritten: string[] = [];

  const footerBase = {
    orchestratorMarker: config.orchestratorMarker,
    phase: "handoff",
    runId,
    model,
    promptVersion: HANDOFF_PROMPT_VERSION,
    targetRepo: resolved.targetRepo,
    baseBranch: resolved.baseBranch,
  };

  const client = createLinearClient(linearApiKey);
  const github = new GitHubClient({ token: githubToken });

  try {
    const comments = await listIssueComments(client, issue.id);
    const idempotency = checkHandoffIdempotency(
      config,
      issue,
      comments,
      Boolean(options.force),
    );
    if (idempotency.skip) {
      await events.log("idempotency_skip", "info", { reason: idempotency.reason });
      finalOutcome = "duplicate";
      errorClassification = "duplicate_phase_completed";
      const manifest: RunManifest = {
        runId,
        issueKey: options.issueKey,
        phase,
        phaseInferredFromStatus,
        linearStatusBefore,
        linearStatusAfter,
        targetRepo: resolved.targetRepo,
        baseBranch: resolved.baseBranch,
        resolutionSource: resolved.resolutionSource,
        dryRun: false,
        finalOutcome,
        errorClassification,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        milestone: MILESTONE,
        promptVersion: HANDOFF_PROMPT_VERSION,
        cursorAgentId: null,
        cursorRunId: null,
        branch,
        prUrl,
        previewUrl,
        validationSummary: null,
        changedFiles,
        checkSummary,
        previousImplementationRunId,
        previousHandoffRunId: null,
        pmFeedbackCommentId: null,
        ...emptyMergeManifestFields(),
        model,
      };
      return writeFinalManifest(
        manifest,
        runDirectory,
        parsed,
        resolved,
        events,
        finalOutcome,
        errorClassification,
        phaseTrace,
      );
    }

    try {
      assertHandoffEligibleStatus(config, issue, Boolean(options.force));
    } catch (error) {
      throw new HandoffError(
        "wrong_status",
        error instanceof Error ? error.message : String(error),
      );
    }

    const discoveredPr = await findImplementationPullRequest(
      github,
      resolved.targetRepo,
      resolved.baseBranch,
      issue.identifier,
    );
    if (!discoveredPr) {
      throw new HandoffError(
        "missing_implementation_pr",
        "No open implementation pull request found on GitHub for this issue",
      );
    }

    prUrl = discoveredPr.prUrl;
    branch = discoveredPr.branch;
    previousImplementationRunId = null;

    await mkdir(`${runDirectory}/linear`, { recursive: true });
    await writeFile(
      getImplementationCommentLoadedPath(runDirectory),
      `${JSON.stringify(discoveredPr, null, 2)}\n`,
      "utf8",
    );
    await events.log("github_pr_inspected", "info", {
      prUrl: discoveredPr.prUrl,
      branch: discoveredPr.branch,
      source: "pr_discovery",
    });

    enteredHandoff = true;

    const parsedPr = parsePrUrl(prUrl);
    if (!parsedPr) {
      throw new HandoffError("missing_pr_url", `Invalid PR URL: ${prUrl}`);
    }

    const markerTargetRepo = normalizeRepoUrl(resolved.targetRepo);

    const prInspectionObs = phaseTrace?.startChild(
      "p-dev.github.pr-inspection",
      "span",
    );
    let inspection;
    try {
      inspection = await inspectPullRequest(github, parsedPr, markerTargetRepo);
    } catch (error) {
      prInspectionObs?.end({ finalOutcome: "failed" });
      const classification = classifyGitHubError(error);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("wrong_target_repo")) {
        throw new HandoffError("wrong_target_repo", message);
      }
      if (message.includes("pr_closed")) {
        throw new HandoffError("pr_closed", message);
      }
      throw new HandoffError(classification, message);
    }

    branch = inspection.branch;
    prUrl = inspection.url;
    try {
      assertPrBaseBranchMatches({
        prUrl,
        actualBaseBranch: inspection.baseBranch,
        expectedBaseBranch: resolved.baseBranch,
      });
    } catch (error) {
      prInspectionObs?.end({ finalOutcome: "failed" });
      throw new HandoffError(
        "wrong_pr_base_branch",
        error instanceof Error ? error.message : String(error),
      );
    }
    changedFiles = inspection.changedFiles.map((f) => f.path);
    checkSummary = inspection.checkSummary;
    prInspectionObs?.end({
      changedFileCount: changedFiles.length,
      checkResultCategory: categorizeCheckResult(checkSummary),
      prCreated: true,
    });

    await mkdir(`${runDirectory}/github`, { recursive: true });
    await writeFile(
      getGithubPrPath(runDirectory),
      `${JSON.stringify(inspection, null, 2)}\n`,
      "utf8",
    );
    if (inspection.rawChecks) {
      await writeFile(
        getGithubChecksPath(runDirectory),
        `${JSON.stringify({ check_runs: inspection.rawChecks }, null, 2)}\n`,
        "utf8",
      );
    }
    await events.log("github_pr_inspected", "info", {
      prUrl: inspection.url,
      changedFileCount: changedFiles.length,
    });

    const pollTimeout =
      config.preview?.pollTimeoutSeconds ?? DEFAULT_PREVIEW_POLL_TIMEOUT_SECONDS;
    const pollInterval =
      config.preview?.pollIntervalSeconds ?? DEFAULT_PREVIEW_POLL_INTERVAL_SECONDS;

    let previewWarning: string | null = null;

    if (shouldCaptureApplicationPreview(resolved.previewProvider)) {
      const previewObs = phaseTrace?.startChild("p-dev.preview", "span");
      await events.log("preview_poll_started", "info", {
        pollTimeoutSeconds: pollTimeout,
        pollIntervalSeconds: pollInterval,
      });

      const previewResult = await pollForVercelPreview(
        async () => {
          const latest = await inspectPullRequest(github, parsedPr, markerTargetRepo);
          return latest.comments;
        },
        {
          pollTimeoutSeconds: pollTimeout,
          pollIntervalSeconds: pollInterval,
        },
      );

      previewUrl = previewResult.previewUrl;

      await mkdir(`${runDirectory}/vercel`, { recursive: true });
      await writeFile(
        getVercelDeploymentPath(runDirectory),
        `${JSON.stringify(previewResult, null, 2)}\n`,
        "utf8",
      );

      if (previewUrl) {
        await events.log("preview_captured", "info", {
          previewUrl,
          source: previewResult.source,
        });
        previewObs?.end({
          previewConfigured: true,
          previewAvailable: true,
        });
      } else {
        await events.log("preview_not_found", "warn", {
          warnings: previewResult.warnings,
        });
        previewObs?.end({
          previewConfigured: true,
          previewAvailable: false,
        });
      }

      const allowWithoutPreview =
        config.handoff?.allowPmReviewWithoutPreview ??
        DEFAULT_HANDOFF_ALLOW_PM_REVIEW_WITHOUT_PREVIEW;

      if (!previewUrl && !allowWithoutPreview) {
        throw new HandoffError(
          "preview_not_found",
          previewResult.warnings.join("; ") || "Vercel preview URL not found",
        );
      }

      previewWarning =
        !previewUrl && allowWithoutPreview
          ? previewResult.warnings.join("; ") ||
            "Preview URL not found; proceeding to PM Review per fallback policy"
          : null;
    } else {
      await events.log("application_preview_not_configured", "info", {
        previewProvider: resolved.previewProvider,
        phase: "handoff",
      });
    }

    const publishObs = phaseTrace?.startChild("p-dev.handoff.publish", "span");
    const handoffCommentInput = {
      prTitle: inspection.title,
      prUrl: inspection.url,
      branch: inspection.branch,
      targetRepo: markerTargetRepo,
      baseBranch: resolved.baseBranch,
      previewUrl,
      previewWarning,
      changedFiles,
      checkSummary: inspection.checkSummary,
      harnessRunId: runId,
      previousImplementationRunId,
    };

    const builderEvidence =
      resolveBuilderThreadMarkerEvidence({
        comments,
        orchestratorMarker: config.orchestratorMarker,
        issueKey: issue.identifier,
        targetRepo: markerTargetRepo,
        branch: inspection.branch,
        prUrl: inspection.url,
        previousImplementationRunId: previousImplementationRunId ?? undefined,
      }) ?? {};

    // Create immutable implementation identity BEFORE posting the Linear handoff
    // comment so PR correlation markers survive ephemeral GHA jobs.
    let linearStatuses: Array<{ name: string; type: string; id?: string }> = [];
    try {
      const teamId = resolveAuthoritativeLinearTeamIdFromConfig(config);
      if (teamId) {
        linearStatuses = await listTeamWorkflowStates(client, teamId);
      }
    } catch {
      linearStatuses = [];
    }

    const codeReadiness = await evaluateCodeReviewReadiness({
      config,
      linearStatuses,
      issueKey: options.issueKey,
    });
    // Build-complete ("Code Review is starting") is deferred until durable CR
    // dispatch is proven. PM handoff body may be posted before transition.
    const handoffBody = codeReadiness.configuredReady
      ? buildBuildCompleteCommentBody(handoffCommentInput)
      : buildHandoffCommentBody(handoffCommentInput);
    const logDirectory = config.logDirectory ?? "runs";
    const store = await resolvePhaseWorkflowStateStore({
      config,
      logDirectory,
    });
    const workflowState = await loadOrBootstrapWorkflowState({
      store,
      issueKey: options.issueKey,
      workflowSchemaVersion: codeReadiness.workflowSchemaVersion,
      enabledOptionalPhases: {
        planReview: false,
        codeReview: codeReadiness.requestedEnabled,
      },
      effectiveOptionalPhases: {
        planReview: false,
        codeReview: codeReadiness.configuredReady,
      },
      currentPhaseId: "handoff",
    });

    const implementationArtifact = createImplementationArtifactIdentity({
      targetRepository: markerTargetRepo,
      prNumber: parsedPr.pullNumber,
      prUrl: inspection.url,
      headSha: inspection.headSha,
      baseSha: inspection.baseSha,
      builderRunId:
        builderEvidence.builderOriginRunId ??
        builderEvidence.builderAgentId ??
        runId,
      workflowStateRevision: workflowState.stateRevision + 1,
    });

    const handoffSubjectIdentity = buildHandoffSubjectIdentity({
      issueKey: options.issueKey,
      targetRepo: markerTargetRepo,
      implementationGenerationId:
        implementationArtifact.implementationGenerationId,
      prNumber: implementationArtifact.prNumber,
      headSha: implementationArtifact.headSha,
      diffHash: implementationArtifact.diffHash,
    });

    const subjectIdempotency = checkHandoffIdempotency(
      config,
      issue,
      comments,
      Boolean(options.force),
      { currentSubjectIdentity: handoffSubjectIdentity },
    );
    if (
      subjectIdempotency.skip ||
      workflowState.handoffSubjectIdentity === handoffSubjectIdentity
    ) {
      await events.log("idempotency_skip", "info", {
        reason:
          subjectIdempotency.reason ??
          `handoff subject ${handoffSubjectIdentity} already recorded in durable state`,
        handoffSubjectIdentity,
      });
      finalOutcome = "duplicate";
      errorClassification = "duplicate_phase_completed";
      const manifest: RunManifest = {
        runId,
        issueKey: options.issueKey,
        phase,
        phaseInferredFromStatus,
        linearStatusBefore,
        linearStatusAfter,
        targetRepo: resolved.targetRepo,
        baseBranch: resolved.baseBranch,
        resolutionSource: resolved.resolutionSource,
        dryRun: false,
        finalOutcome,
        errorClassification,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        milestone: MILESTONE,
        promptVersion: HANDOFF_PROMPT_VERSION,
        cursorAgentId: null,
        cursorRunId: null,
        branch,
        prUrl,
        previewUrl,
        validationSummary: null,
        changedFiles,
        checkSummary,
        previousImplementationRunId,
        previousHandoffRunId: null,
        pmFeedbackCommentId: null,
        ...emptyMergeManifestFields(),
        model,
      };
      return writeFinalManifest(
        manifest,
        runDirectory,
        parsed,
        resolved,
        events,
        finalOutcome,
        errorClassification,
        phaseTrace,
      );
    }

    // Decision-before-effects: CAS-record accepted handoff subject + pending effects
    // before posting Linear comment or moving status.
    const commentEffectKind = codeReadiness.configuredReady
      ? ("build_complete_marker" as const)
      : ("handoff_marker" as const);
    const commentEffectId = buildSideEffectIdentity({
      kind: commentEffectKind,
      subjectIdentity: handoffSubjectIdentity,
    });
    const statusEffectId = buildSideEffectIdentity({
      kind: "linear_status_transition",
      subjectIdentity: handoffSubjectIdentity,
      detail: codeReadiness.configuredReady ? "code_review" : "pm_review",
    });
    let durable = upsertPendingSideEffect(
      {
        ...workflowState,
        handoffSubjectIdentity,
        latestImplementationArtifact: implementationArtifact,
        enabledOptionalPhases: {
          ...workflowState.enabledOptionalPhases,
          codeReview: codeReadiness.requestedEnabled,
        },
        effectiveOptionalPhases: {
          ...workflowState.effectiveOptionalPhases,
          codeReview: codeReadiness.configuredReady,
        },
      },
      { identity: commentEffectId, kind: commentEffectKind },
    );
    durable = upsertPendingSideEffect(durable, {
      identity: statusEffectId,
      kind: "linear_status_transition",
    });
    const acceptedRevision = workflowState.stateRevision + 1;
    durable = { ...durable, stateRevision: acceptedRevision };
    const casAccepted = await store.compareAndSet({
      issueKey: options.issueKey,
      expectedRevision: workflowState.stateRevision,
      next: durable,
    });
    if (!casAccepted) {
      throw new HandoffError(
        "linear_write_failure",
        "Failed to CAS-accept handoff subject into durable workflow state before side effects.",
      );
    }

    const postHandoffLinearComment = async (): Promise<string | null> => {
      if (isSideEffectCompleted(durable, commentEffectId)) {
        return null;
      }
      const commentId = await postHandoffComment(client, issue.id, handoffBody, {
        ...footerBase,
        phase: codeReadiness.configuredReady ? "build_complete" : "handoff",
        branch: branch ?? undefined,
        prUrl: prUrl ?? undefined,
        previewUrl: previewUrl ?? undefined,
        previousImplementationRunId: previousImplementationRunId ?? undefined,
        builderAgentId: builderEvidence.builderAgentId,
        builderThreadGeneration: builderEvidence.builderThreadGeneration,
        builderThreadAction: builderEvidence.builderThreadAction,
        builderOriginRunId: builderEvidence.builderOriginRunId,
        builderThreadIdempotencyKey: builderEvidence.builderThreadIdempotencyKey,
        previousBuilderAgentId: builderEvidence.previousBuilderAgentId,
        builderThreadReplacementReason:
          builderEvidence.builderThreadReplacementReason,
        implementationGenerationId:
          implementationArtifact.implementationGenerationId,
        prNumber: String(implementationArtifact.prNumber),
        prHeadSha: implementationArtifact.headSha,
        prBaseSha: implementationArtifact.baseSha,
        diffHash: implementationArtifact.diffHash,
        handoffSubjectIdentity,
      });
      durable = markSideEffectCompleted(durable, commentEffectId);
      durable = {
        ...durable,
        stateRevision: durable.stateRevision + 1,
      };
      await store.compareAndSet({
        issueKey: options.issueKey,
        expectedRevision: durable.stateRevision - 1,
        next: durable,
      });
      commentsWritten.push(handoffBody);
      await mkdir(`${runDirectory}/linear`, { recursive: true });
      await writeFile(
        getHandoffCommentPath(runDirectory),
        `${handoffBody}\n`,
        "utf8",
      );
      await events.log("handoff_comment_posted", "info", {
        commentId,
        implementationGenerationId:
          implementationArtifact.implementationGenerationId,
      });
      await events.log("linear_comment_posted", "info", {
        phase: "handoff",
        commentId,
      });
      return commentId;
    };

    // PM handoff path: comment may precede transition. Code Review path must
    // not claim "Code Review is starting" until opaque dispatch is proven.
    if (!codeReadiness.configuredReady) {
      await postHandoffLinearComment();
      publishObs?.end({
        changedFileCount: changedFiles?.length ?? null,
        previewAvailable: Boolean(previewUrl),
        checkResultCategory: categorizeCheckResult(checkSummary),
      });
    }

    // Clear the implementation-owned lease (not the handoff run id). Handoff
    // run id never matches lease.ownerRunId, so clearActiveRunId: runId was a
    // no-op and left Code Review blocked on active_run_conflict (FRE-7).
    const implementationLease =
      durable.activeRunLease &&
      (durable.activeRunLease.phaseId === "implementation" ||
        durable.activeRunLease.identity.startsWith("implementation:"))
        ? {
            expectedIdentity: durable.activeRunLease.identity,
            expectedOwnerRunId: durable.activeRunLease.ownerRunId,
          }
        : undefined;

    const applied = await applyPhaseTransition({
      store,
      issueKey: options.issueKey,
      config,
      expectedStateRevision: durable.stateRevision,
      currentPhaseId: "handoff",
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: runId,
      },
      evidence: { linearStatusName: linearStatusBefore ?? "" },
      codeReviewEffectiveEnabled: codeReadiness.configuredReady,
      linearStatuses,
      latestImplementationArtifact: implementationArtifact,
      clearActiveRunLease: implementationLease,
    });

    if (!applied.applyOk || !applied.statusName) {
      throw new HandoffError(
        "linear_write_failure",
        `Handoff transition rejected: ${applied.reason}`,
      );
    }

    // Critical: always dispatch from the post-transition authoritative revision.
    durable =
      applied.state ??
      (await store.load(options.issueKey)) ??
      durable;
    durable = {
      ...durable,
      effectiveOptionalPhases: {
        ...durable.effectiveOptionalPhases,
        codeReview: codeReadiness.configuredReady,
      },
    };

    if (codeReadiness.configuredReady) {
      const reviewCycle = durable.cycleCounters.code_review_cycles ?? 0;
      const reviewSubjectIdentity = buildCodeReviewSubjectIdentity({
        issueKey: options.issueKey,
        prNumber: implementationArtifact.prNumber,
        headSha: implementationArtifact.headSha,
        diffHash: implementationArtifact.diffHash,
        reviewCycle,
      });
      const dispatchResult = await ensureCodeReviewJobDispatched({
        store,
        issueKey: options.issueKey,
        reviewSubjectIdentity,
        ownerGeneration: runId,
        state: durable,
      });
      durable = dispatchResult.state;
      phaseTrace
        ?.startChild("p-dev.code-review.dispatch", "event")
        ?.end({
          outcome: dispatchResult.outcome,
          reviewSubjectIdentity,
          reviewRequestId: dispatchResult.reviewRequestId,
          httpDispatched: dispatchResult.httpDispatched,
          claimLostRecoveries: dispatchResult.claimLostRecoveries,
          stateRevision: durable.stateRevision,
        });
      await events.log("code_review_dispatch_attempt", "info", {
        reviewSubjectIdentity,
        reviewRequestId: dispatchResult.reviewRequestId,
        outcome: dispatchResult.outcome,
        httpDispatched: dispatchResult.httpDispatched,
        claimLostRecoveries: dispatchResult.claimLostRecoveries,
        prNumber: implementationArtifact.prNumber,
        headSha: implementationArtifact.headSha,
        stateRevision: durable.stateRevision,
      });
      if (dispatchResult.outcome === "missing_dispatch_token") {
        throw new Error(MISSING_DISPATCH_TOKEN_MESSAGE);
      }
      if (!isCodeReviewDispatchProven(dispatchResult.outcome)) {
        throw new HandoffError(
          "configuration_error",
          `code_review_dispatch_${dispatchResult.outcome}: durable Code Review request was not proven after handoff transition (subject=${reviewSubjectIdentity}, request=${dispatchResult.reviewRequestId}, recoveries=${dispatchResult.claimLostRecoveries}). Resume with harness:reconcile-workflow --issue ${options.issueKey} --phase code_review --subject ${reviewSubjectIdentity} --dispatch.`,
        );
      }
      await events.log("code_review_job_dispatched", "info", {
        reviewSubjectIdentity,
        reviewRequestId: dispatchResult.reviewRequestId,
        outcome: dispatchResult.outcome,
        httpDispatched: dispatchResult.httpDispatched,
        claimLostRecoveries: dispatchResult.claimLostRecoveries,
        prNumber: implementationArtifact.prNumber,
        headSha: implementationArtifact.headSha,
      });
      // Only now is it truthful to say Code Review is starting.
      await postHandoffLinearComment();
      publishObs?.end({
        changedFileCount: changedFiles?.length ?? null,
        previewAvailable: Boolean(previewUrl),
        checkResultCategory: categorizeCheckResult(checkSummary),
      });
    }

    const nextStatus = applied.statusName;
    await transitionIssueStatus(client, issue, nextStatus);
    linearStatusAfter = nextStatus;
    await events.log("linear_status_changed", "info", {
      from: linearStatusBefore,
      to: nextStatus,
      transitionReason: applied.result?.reason ?? null,
      bypass: applied.result?.bypass?.event ?? null,
    });
    phaseTrace
      ?.startChild("p-dev.linear.status-transition", "event")
      ?.end({
        linearStatusBefore,
        linearStatusAfter: nextStatus,
      });

    const afterIssue = await fetchLinearIssue(options.issueKey, linearApiKey);
    await writeFile(
      getIssueSnapshotAfterPath(runDirectory),
      `${JSON.stringify(afterIssue, null, 2)}\n`,
      "utf8",
    );

    if (commentsWritten.length > 0) {
      await writeCommentsArtifact(runDirectory, commentsWritten);
    }

    finalOutcome = "success";
    errorClassification = null;
  } catch (error) {
    const message = extractErrorMessage(error);
    if (error instanceof HandoffError) {
      errorClassification = error.classification;
    } else {
      errorClassification = classifyUnexpectedPhaseError(error);
    }
    await events.log("phase_error", "error", {
      message,
      errorClassification,
      enteredHandoff,
    });
    await writeErrorArtifact(runDirectory, message, errorClassification);

    if (isStaleEligibilitySkip(error, enteredHandoff)) {
      finalOutcome = "skipped";
      await events.log("stale_eligibility_skip", "info", {
        reason: message,
        status: linearStatusAfter,
      });
    } else if (enteredHandoff) {
      try {
        const errorMessage =
          errorClassification === "configuration_error" &&
          (message === "missing_dispatch_token" ||
            message.startsWith("missing_dispatch_token"))
            ? MISSING_DISPATCH_TOKEN_MESSAGE
            : message;
        await postErrorComment(
          client,
          issue.id,
          errorMessage,
          {
            ...footerBase,
            branch: branch ?? undefined,
            prUrl: prUrl ?? undefined,
            previewUrl: previewUrl ?? undefined,
            previousImplementationRunId: previousImplementationRunId ?? undefined,
          },
          "handoff",
          { errorClassification: errorClassification ?? undefined },
        );
        const blocked = resolveNextStatusName({
          config,
          currentPhaseId: "handoff",
          outcome: {
            kind: "failure",
            phaseId: "handoff",
            attemptIdentity: `${runId}:failure`,
          },
          evidence: { linearStatusName: linearStatusBefore ?? "PR Open" },
        }).statusName;
        await transitionIssueStatus(client, issue, blocked);
        linearStatusAfter = blocked;
        await events.log("linear_status_changed", "info", {
          to: blocked,
          reason: "failure",
        });
      } catch {
        // Best-effort blocker update.
      }
    }
  }

  const manifest: RunManifest = {
    runId,
    issueKey: options.issueKey,
    phase: "handoff",
    phaseInferredFromStatus,
    linearStatusBefore,
    linearStatusAfter,
    targetRepo: resolved.targetRepo,
    baseBranch: resolved.baseBranch,
    resolutionSource: resolved.resolutionSource,
    dryRun: false,
    finalOutcome,
    errorClassification,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    milestone: MILESTONE,
    promptVersion: HANDOFF_PROMPT_VERSION,
    cursorAgentId: null,
    cursorRunId: null,
    branch,
    prUrl,
    previewUrl,
    validationSummary: checkSummary,
    changedFiles,
    checkSummary,
    previousImplementationRunId,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
  };

  return writeFinalManifest(
    manifest,
    runDirectory,
    parsed,
    resolved,
    events,
    finalOutcome,
    errorClassification,
    phaseTrace,
    {
      totalPhaseDurationMs: Date.now() - startedAt.getTime(),
      changedFileCount: changedFiles?.length ?? null,
      checkResultCategory: categorizeCheckResult(checkSummary),
      previewConfigured: shouldCaptureApplicationPreview(resolved.previewProvider),
      promptContractVersion: HANDOFF_PROMPT_VERSION,
    },
    options.evaluationRuntime ?? null,
  );
}
