/**
 * Code Review phase — independent reviewer agent + fail-closed readiness/eligibility.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODE_REVIEW_PROMPT_VERSION,
  DEFAULT_PLANNING_TIMEOUT_SECONDS,
  MILESTONE,
} from "../../config/defaults.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getCodeReviewPromptPath,
  getCodeReviewResultPath,
  getIssueSnapshotAfterPath,
  getRunDirectory,
} from "../../artifacts/paths.js";
import { EventLogger } from "../../artifacts/events.js";
import { fetchLinearIssue } from "../../linear/client.js";
import {
  createLinearClient,
  listIssueComments,
  postErrorComment,
  postHandoffComment,
  postIssueComment,
  transitionIssueStatus,
} from "../../linear/writer.js";
import { formatCodeReviewComment } from "../../linear/code-review-comment.js";
import {
  buildHandoffCommentBody,
  hasPmHandoffMarker,
} from "../../linear/comments.js";
import {
  createCodeReviewAgent,
  disposeAgent,
  downloadAgentReviewArtifacts,
  sendAndObserve,
} from "../../agents/index.js";
import { selectPrimaryReviewArtifact } from "../../cursor/review-artifacts.js";
import { buildCodeReviewSubjectIdentity } from "../../workflow/subject-identities.js";
import {
  claimAgentRun,
  DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
  isActiveRunLeaseExpired,
} from "../../workflow/state/index.js";
import { resolveDefinitionForConfig } from "../workflow-transition.js";
import { manifestModelEvidence } from "../../cursor/model.js";
import { buildCodeReviewPrompt } from "../../prompts/builder.js";
import { CodeReviewError } from "../errors.js";
import {
  classifyUnexpectedPhaseError,
  extractErrorMessage,
} from "../classify-phase-error.js";
import { resolveRunGeneration } from "../run-generation.js";
import { parseIssueDescription } from "../../linear/parser.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import { applyPhaseTransition } from "../workflow-transition.js";
import {
    loadOrBootstrapWorkflowState,
} from "../../workflow/state/index.js";
import { resolvePhaseWorkflowStateStore } from "../../workflow/state/resolve-store.js";
import {
  buildCodeReviewExecutionEligibilityDiagnostic,
  buildCodeReviewPhaseExecutionFreeze,
  buildCodeReviewReadinessDiagnostic,
  evaluateCodeReviewExecutionEligibility,
  evaluateCodeReviewReadiness,
} from "../../workflow/code-review-readiness.js";
import { toEngineCodeReviewOutcome } from "../../workflow/review-contracts.js";
import {
  REVIEW_DECISION_REPAIR_PROMPT,
  extractReviewDecision,
  extractReviewDecisionAfterRepair,
} from "../../workflow/review-decision-extract.js";
import { buildTelemetryCorrelation } from "../../evaluation/telemetry/correlation.js";
import {
  buildPromptProvenance,
  buildSkillProvenance,
  PHASE_ELIGIBLE_SKILLS,
} from "../../evaluation/telemetry/provenance.js";
import {
  agentObsMetadataFromObserved,
  emitPromptProvenanceEvent,
  emitSkillProvenanceEvent,
} from "../../evaluation/telemetry/phase-emit.js";
import type {
  EvaluationRuntime,
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../evaluation/types.js";
import {
  finalizePhaseEvaluation,
  safeStartPhaseTrace,
} from "../../evaluation/phase-helpers.js";
import { agentObservationDisplayName } from "../../evaluation/naming.js";
import { promptNameForPhase } from "../../prompts/skill-inject.js";
import { allowsLangfuseContentProjection } from "../../evaluation/telemetry/profiles.js";
import { boundRedactedContent } from "../../evaluation/telemetry/redact.js";
import { MAX_LANGFUSE_CONTENT_CHARS } from "../../evaluation/telemetry/bounds.js";
import { buildArtifactRef } from "../../evaluation/telemetry/artifact-ref.js";
import type {
  ErrorClassification,
  FinalOutcome,
  RunManifest,
} from "../../types/run.js";
import {
  captureWorkflowAnalyticsEvent,
  buildWorkflowAnalyticsProperties,
} from "../../observability/workflow-analytics.js";
import { resolveAuthoritativeLinearTeamIdFromConfig } from "../../config/resolve-linear-team.js";
import { listTeamWorkflowStates } from "../../setup/linear-setup-client.js";
import { GitHubClient } from "../../github/client.js";
import { inspectPullRequest } from "../../github/pr-inspector.js";
import { parsePrUrl } from "../../github/pr-url.js";
import { normalizeRepoUrl } from "../../resolver/normalize-repo.js";
import { buildLivePrEvidence } from "./pr-live-evidence.js";

export interface CodeReviewPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface CodeReviewPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new CodeReviewError(
      name === "LINEAR_API_KEY"
        ? "linear_auth_failure"
        : name === "GITHUB_TOKEN"
          ? "github_auth_failure"
          : "cursor_api_failure",
      `${name} is required for live code review runs`,
    );
  }
  return value;
}

export async function executeCodeReviewPhase(
  options: CodeReviewPhaseOptions,
): Promise<CodeReviewPhaseResult> {
  const startedAt = new Date();
  const runId = `code-review-${startedAt.getTime()}`;
  const deliveryId = process.env.GITHUB_RUN_ID ?? runId;
  const runGeneration = resolveRunGeneration();
  let { config } = await loadHarnessConfig({ configPath: options.configPath });
  const logDirectory = config.logDirectory ?? "runs";
  const runDirectory = getRunDirectory(logDirectory, options.issueKey, runId);
  await mkdir(runDirectory, { recursive: true });
  const events = new EventLogger(runDirectory);
  await events.init();
  await events.log("run_started", "info", { phase: "code_review", runId });

  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const cursorApiKey = requireEnv("CURSOR_API_KEY");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const client = createLinearClient(linearApiKey);
  const github = new GitHubClient({ token: githubToken });
  const issue = await fetchLinearIssue(options.issueKey, linearApiKey);
  const parsed = parseIssueDescription(issue.description ?? "");
  {
    const { resolveIssueConfiguration, applyValidationRunModelSelections } =
      await import("../../workflow/validation-run/index.js");
    const { WORKFLOW_SCHEMA_VERSION } = await import(
      "../../workflow/definition/product-development.v2.js"
    );
    const issueConfig = await resolveIssueConfiguration({
      issueKey: options.issueKey,
      workflowSchemaVersion:
        config.workflow?.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
      linearTeamId:
        config.linear?.teamId ??
        config.repos[0]?.linearAssociations?.[0]?.teamId ??
        null,
      inlineSnapshots: config.validationRuns ?? null,
    });
    if (issueConfig.applied) {
      config = applyValidationRunModelSelections(config, issueConfig.snapshot);
    }
  }
  const resolved = resolveTargetRepo(
    parsed,
    {
      projectName: issue.projectName ?? undefined,
      teamName: issue.teamName ?? undefined,
      teamKey: issue.teamKey ?? undefined,
      teamId: issue.teamId ?? undefined,
      projectId: issue.projectId ?? undefined,
    },
    config,
  );

  const reviewerModel = manifestModelEvidence(config, "codeReviewer");
  const model = reviewerModel.model;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = "cursor_run_failed";
  let ownedActiveClaim = false;
  let linearStatusAfter: string | null = issue.status;
  let phaseTrace: PhaseTraceHandle | null = null;
  let reviewerObs: NestedObservationHandle | null = null;
  let promptVersion: string | null = null;
  let cursorAgentId: string | null = null;
  let cursorRunId: string | null = null;
  let extraEvalMetadata: Record<string, unknown> = {};

  const store = await resolvePhaseWorkflowStateStore({
    config,
    logDirectory,
  });
  let linearStatuses: Array<{ name: string; type: string; id?: string }> = [];
  try {
    const teamId = resolveAuthoritativeLinearTeamIdFromConfig(config);
    if (teamId) {
      linearStatuses = await listTeamWorkflowStates(client, teamId);
    }
  } catch {
    linearStatuses = [];
  }

  const readiness = await evaluateCodeReviewReadiness({
    config,
    linearStatuses,
    issueKey: options.issueKey,
  });
  const readinessDiag = buildCodeReviewReadinessDiagnostic({
    readiness,
    configurationSurface: "runner",
  });
  captureWorkflowAnalyticsEvent(
    readinessDiag.event,
    readinessDiag.properties,
  );

  if (!readiness.configuredReady) {
    await events.log("plan_review_not_effective", "warn", {
      requestedEnabled: readiness.requestedEnabled,
      missingRequirements: readiness.missingRequirements,
    });
    throw new CodeReviewError(
      "wrong_status",
      `Code Review is not configured ready: ${readiness.missingRequirementMessages.join(" ")}`,
    );
  }

  let state = await loadOrBootstrapWorkflowState({
    store,
    issueKey: options.issueKey,
    workflowSchemaVersion: readiness.workflowSchemaVersion,
    enabledOptionalPhases: {
      planReview: false,
      codeReview: readiness.requestedEnabled,
    },
    effectiveOptionalPhases: {
      planReview: false,
      codeReview: readiness.configuredReady,
    },
    currentPhaseId: "code_review",
  });

  const reviserModel = manifestModelEvidence(config, "codeReviser");
  const freeze =
    state.phaseExecutionFreeze?.configuredReady === true
      ? state.phaseExecutionFreeze
      : buildCodeReviewPhaseExecutionFreeze({
          readiness,
          codeReviewerModelId: reviewerModel.model,
          codeReviewerFast:
            reviewerModel.effectiveVariant === "fast"
              ? true
              : reviewerModel.effectiveVariant === "standard"
                ? false
                : null,
          codeReviserModelId: reviserModel.model,
          codeReviserFast:
            reviserModel.effectiveVariant === "fast"
              ? true
              : reviserModel.effectiveVariant === "standard"
                ? false
                : null,
        });

  if (!freeze.configuredReady) {
    throw new CodeReviewError(
      "wrong_status",
      "Frozen phase execution has Code Review configuredReady=false",
    );
  }

  const markerTargetRepo = normalizeRepoUrl(resolved.targetRepo);
  let latestImplementation = state.latestImplementationArtifact;
  let recoveredImplementationArtifact = false;
  const comments = await listIssueComments(client, issue.id);
  if (!latestImplementation) {
    const {
      recoverPrLocatorFromHandoffComments,
      buildRecoveredImplementationArtifact,
    } = await import("../../workflow/recover-implementation-artifact.js");
    const locator = recoverPrLocatorFromHandoffComments({
      comments,
      orchestratorMarker: config.orchestratorMarker,
      targetRepository: markerTargetRepo,
    });
    if (locator) {
      const parsedLocatorPr = parsePrUrl(locator.prUrl);
      if (parsedLocatorPr) {
        try {
          const inspection = await inspectPullRequest(
            github,
            parsedLocatorPr,
            markerTargetRepo,
          );
          latestImplementation = buildRecoveredImplementationArtifact({
            locator,
            headSha: inspection.headSha,
            baseSha: inspection.baseSha,
          });
          recoveredImplementationArtifact = true;
          state = {
            ...state,
            latestImplementationArtifact: latestImplementation,
          };
          await events.log(
            "implementation_artifact_recovered_from_linear",
            "info",
            {
              implementationGenerationId:
                latestImplementation.implementationGenerationId,
              prNumber: latestImplementation.prNumber,
              headSha: latestImplementation.headSha,
              builderRunId: latestImplementation.builderRunId,
            },
          );
        } catch (error) {
          await events.log("github_pr_inspected", "warn", {
            source: "recovery_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  if (!latestImplementation) {
    const eligibility = evaluateCodeReviewExecutionEligibility({
      latestImplementation: null,
    });
    const eligibilityDiag = buildCodeReviewExecutionEligibilityDiagnostic({
      eligibility,
      configurationSurface: "runner",
    });
    captureWorkflowAnalyticsEvent(
      eligibilityDiag.event,
      eligibilityDiag.properties,
    );
    throw new CodeReviewError(
      "missing_implementation_pr",
      "No durable PR/implementation artifact is available for Code Review",
    );
  }

  const parsedPr = parsePrUrl(latestImplementation.prUrl);
  if (!parsedPr) {
    throw new CodeReviewError(
      "missing_implementation_pr",
      `Invalid implementation PR URL: ${latestImplementation.prUrl}`,
    );
  }

  let liveEvidence;
  let branchName = "";
  try {
    const inspection = await inspectPullRequest(
      github,
      parsedPr,
      markerTargetRepo,
    );
    branchName = inspection.branch;
    liveEvidence = buildLivePrEvidence({
      inspection,
      parsed: parsedPr,
      targetRepo: markerTargetRepo,
    });
  } catch (error) {
    // Tests may inject artifact-only evidence when GitHub is unavailable.
    liveEvidence = {
      prNumber: latestImplementation.prNumber,
      repository: latestImplementation.targetRepository,
      headSha: latestImplementation.headSha,
      baseSha: latestImplementation.baseSha,
      diffHash: latestImplementation.diffHash,
    };
    await events.log("github_pr_inspected", "warn", {
      source: "artifact_stub",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const reviewCycle = state.cycleCounters.code_review_cycles ?? 0;
  const reviewSubjectIdentity = buildCodeReviewSubjectIdentity({
    issueKey: options.issueKey,
    prNumber: latestImplementation.prNumber,
    headSha: latestImplementation.headSha,
    diffHash: latestImplementation.diffHash,
    reviewCycle,
  });
  const acceptedForSubject =
    state.acceptedReviewSubjects?.[reviewSubjectIdentity] ??
    (state.lastAcceptedReviewDecision?.reviewedPrNumber ===
      latestImplementation.prNumber &&
    state.lastAcceptedReviewDecision.reviewedHeadSha ===
      latestImplementation.headSha &&
    state.lastAcceptedReviewDecision.reviewedDiffHash ===
      latestImplementation.diffHash
      ? state.lastAcceptedReviewDecision.decisionIdentity
      : null);

  if (acceptedForSubject) {
    await events.log("idempotency_skip", "info", {
      reason: "code_review_subject_already_accepted",
      reviewSubjectIdentity,
      decisionIdentity: acceptedForSubject,
    });
    finalOutcome = "duplicate";
    errorClassification = "duplicate_phase_completed";
    const manifest: RunManifest = {
      runId,
      issueKey: options.issueKey,
      phase: "code_review",
      phaseInferredFromStatus: issue.status,
      linearStatusBefore: issue.status,
      linearStatusAfter: issue.status,
      targetRepo: resolved.targetRepo,
      baseBranch: resolved.baseBranch,
      resolutionSource: resolved.resolutionSource,
      dryRun: false,
      finalOutcome,
      errorClassification,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      milestone: MILESTONE,
      promptVersion: null,
      cursorAgentId: null,
      cursorRunId: null,
      branch: null,
      prUrl: latestImplementation.prUrl,
      previewUrl: null,
      validationSummary: null,
      changedFiles: null,
      checkSummary: null,
      previousImplementationRunId: latestImplementation.builderRunId,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model,
      deliveryId,
      runGeneration,
      runOwnedStatuses: [],
    };
    await writeManifest(runDirectory, manifest);
    await writeRunSummary(runDirectory, manifest, parsed, resolved);
    return { manifest, runDirectory, exitCode: 0 };
  }

  const eligibility = evaluateCodeReviewExecutionEligibility({
    latestImplementation,
    liveEvidence,
    activeRunIdentities: state.activeRunIdentities,
    activeRunLeaseIdentity: state.activeRunLease?.identity ?? null,
    completedPhaseIdentities: state.completedPhaseIdentities,
    supersededGenerationIds: state.supersededGenerationIdentities,
    reviewSubjectIdentity,
    acceptedDecisionIdentityForSubject: acceptedForSubject,
  });
  const eligibilityDiag = buildCodeReviewExecutionEligibilityDiagnostic({
    eligibility,
    configurationSurface: "runner",
  });
  captureWorkflowAnalyticsEvent(eligibilityDiag.event, eligibilityDiag.properties);

  if (
    !eligibility.executionEligible &&
    eligibility.failureCodes.includes("reviewer_identity_already_owns_generation")
  ) {
    await events.log("idempotency_skip", "info", {
      reason: "code_review_subject_lease_active_or_accepted",
      reviewSubjectIdentity,
      failureCodes: eligibility.failureCodes,
    });
    finalOutcome = "duplicate";
    errorClassification = "duplicate_phase_completed";
    const manifest: RunManifest = {
      runId,
      issueKey: options.issueKey,
      phase: "code_review",
      phaseInferredFromStatus: issue.status,
      linearStatusBefore: issue.status,
      linearStatusAfter: issue.status,
      targetRepo: resolved.targetRepo,
      baseBranch: resolved.baseBranch,
      resolutionSource: resolved.resolutionSource,
      dryRun: false,
      finalOutcome,
      errorClassification,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      milestone: MILESTONE,
      promptVersion: null,
      cursorAgentId: null,
      cursorRunId: null,
      branch: null,
      prUrl: latestImplementation.prUrl,
      previewUrl: null,
      validationSummary: null,
      changedFiles: null,
      checkSummary: null,
      previousImplementationRunId: latestImplementation.builderRunId,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model,
      deliveryId,
      runGeneration,
      runOwnedStatuses: [],
    };
    await writeManifest(runDirectory, manifest);
    await writeRunSummary(runDirectory, manifest, parsed, resolved);
    return { manifest, runDirectory, exitCode: 0 };
  }

  if (!eligibility.executionEligible) {
    throw new CodeReviewError(
      "validation_failed",
      `Code Review execution is not eligible: ${eligibility.failureMessages.join(" ")}`,
    );
  }

  const definition = resolveDefinitionForConfig({
    config,
    codeReviewEffectiveEnabled: true,
    linearStatuses,
  });
  const leaseIdentity = `code_review:${reviewSubjectIdentity}`;
  const claimResult = await claimAgentRun({
    store,
    issueKey: options.issueKey,
    definition,
    expectedStateRevision: state.stateRevision,
    currentPhaseId: "code_review",
    runId,
    evidence: {
      linearStatusName: issue.status ?? readiness.codeReviewStatusName,
      latestPrNumber: latestImplementation.prNumber,
      latestHeadSha: latestImplementation.headSha,
      latestBaseSha: latestImplementation.baseSha,
      latestDiffHash: latestImplementation.diffHash,
      latestImplementationGenerationId:
        latestImplementation.implementationGenerationId,
    },
    leaseIdentity,
    subjectIdentity: reviewSubjectIdentity,
    leaseTtlMs: DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
  });
  if (!claimResult.ok) {
    const claimReason = String(claimResult.reason ?? "");
    const lease = claimResult.state?.activeRunLease ?? state.activeRunLease;
    const leaseExpired = isActiveRunLeaseExpired(lease, Date.now());
    const sameSubjectActive =
      lease?.identity === leaseIdentity && !leaseExpired;
    // Only treat as completed duplicate when durable acceptance exists.
    // active_run_conflict alone must never terminalize as duplicate_phase_completed.
    let claimOutcome: FinalOutcome = "failed";
    let claimClassification: ErrorClassification = "foreign_active_run_conflict";
    let exitCode = 1;
    if (acceptedForSubject) {
      claimOutcome = "duplicate";
      claimClassification = "duplicate_phase_completed";
      exitCode = 0;
    } else if (sameSubjectActive || claimReason.includes("already_active")) {
      claimOutcome = "duplicate";
      claimClassification = "active_run_already_claimed";
      exitCode = 0;
    } else if (leaseExpired) {
      claimClassification = "foreign_active_run_conflict";
      exitCode = 1;
    } else if (claimReason.includes("foreign_active_conflict")) {
      claimClassification = "foreign_active_run_conflict";
      exitCode = 1;
    } else {
      claimClassification = "foreign_active_run_conflict";
      exitCode = 1;
    }
    await events.log(
      claimOutcome === "duplicate" ? "idempotency_skip" : "cursor_event",
      claimOutcome === "duplicate" ? "info" : "warn",
      {
        reason: "code_review_claim_conflict",
        reviewSubjectIdentity,
        claimReason,
        leaseIdentity: lease?.identity ?? null,
        leaseOwnerRunId: lease?.ownerRunId ?? null,
        claimClassification,
      },
    );
    finalOutcome = claimOutcome;
    errorClassification = claimClassification;
    const manifest: RunManifest = {
      runId,
      issueKey: options.issueKey,
      phase: "code_review",
      phaseInferredFromStatus: issue.status,
      linearStatusBefore: issue.status,
      linearStatusAfter: issue.status,
      targetRepo: resolved.targetRepo,
      baseBranch: resolved.baseBranch,
      resolutionSource: resolved.resolutionSource,
      dryRun: false,
      finalOutcome,
      errorClassification,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      milestone: MILESTONE,
      promptVersion: null,
      cursorAgentId: null,
      cursorRunId: null,
      branch: null,
      prUrl: latestImplementation.prUrl,
      previewUrl: null,
      validationSummary: null,
      changedFiles: null,
      checkSummary: null,
      previousImplementationRunId: latestImplementation.builderRunId,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model,
      deliveryId,
      runGeneration,
      runOwnedStatuses: [],
    };
    await writeManifest(runDirectory, manifest);
    await writeRunSummary(runDirectory, manifest, parsed, resolved);
    return { manifest, runDirectory, exitCode };
  }
  state = claimResult.state ?? state;
  ownedActiveClaim = true;

  const previousFeedback =
    state.lastAcceptedReviewDecision?.decision === "needs_revision" &&
    state.lastAcceptedReviewDecision.phaseId === "code_review" &&
    state.lastAcceptedReviewDecision.findings
      ? state.lastAcceptedReviewDecision.findings
          .filter((f) => f.severity === "blocking")
          .map(
            (f) =>
              `- ${f.id} (${f.category}): ${f.evidence}${
                f.requiredChange ? ` → ${f.requiredChange}` : ""
              }`,
          )
          .join("\n")
      : "_None._";

  const changedFilesSummary = `_PR #${latestImplementation.prNumber} at \`${latestImplementation.headSha.slice(0, 7)}\`._`;

  try {
    const { prompt: basePrompt, promptVersion: version } =
      await buildCodeReviewPrompt({
        issue,
        parsed,
        reviewedPrNumber: latestImplementation.prNumber,
        reviewedHeadSha: latestImplementation.headSha,
        reviewedBaseSha: latestImplementation.baseSha,
        reviewedDiffHash: latestImplementation.diffHash,
        prUrl: latestImplementation.prUrl,
        targetRepository: latestImplementation.targetRepository,
        changedFilesSummary,
        priorAcceptedFeedback: previousFeedback,
        codeReviewCycle: state.cycleCounters.code_review_cycles ?? 0,
        codeReviewCycleLimit: freeze.cycleLimit,
        approvedPlanIdentity:
          state.latestPlanArtifact?.planGenerationId ?? undefined,
      });
    promptVersion = version;
    const { assembleAgentPrompt } = await import("../../prompts/assemble.js");
    const skillInjection = await assembleAgentPrompt({
      phase: "code_review",
      localCompiledPrompt: basePrompt,
    });
    const prompt = skillInjection.prompt;
    await mkdir(path.join(runDirectory, "prompts"), { recursive: true });
    const promptPath = getCodeReviewPromptPath(runDirectory);
    await writeFile(promptPath, `${prompt}\n`, "utf8");

    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "code_review",
      issueKey: issue.identifier,
      runId,
      linearTeamKey: issue.teamKey ?? null,
      metadata: {
        modelId: model,
        modelRole: "code_reviewer",
        promptContractVersion: version,
        reviewedPrNumber: latestImplementation.prNumber,
        reviewedHeadSha: latestImplementation.headSha,
        reviewedDiffHash: latestImplementation.diffHash,
        codeReviewCycle: state.cycleCounters.code_review_cycles ?? 0,
        codeReviewCycleLimit: freeze.cycleLimit,
      },
    });

    const telemetryCorrelation = buildTelemetryCorrelation({
      namespace: options.evaluationRuntime?.namespace ?? "default",
      issueKey: issue.identifier,
      harnessRunId: runId,
      phase: "code_review",
      providerTraceId: phaseTrace?.correlation.traceId,
    });
    const promptProvenance = await buildPromptProvenance({
      runDirectory,
      promptContractVersion: version,
      promptTemplatePath: "src/prompts/code-review.md",
      renderedPromptAbsolutePath: promptPath,
    });
    const declaredSkills = skillInjection.skillsUsed.map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
    }));
    const skillProvenance = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.code_review ?? [],
      declared: declaredSkills,
      observed: declaredSkills,
    });
    const onTelemetry = (
      e: Parameters<NonNullable<PhaseTraceHandle["onTelemetryEvent"]>>[0],
    ) => phaseTrace?.onTelemetryEvent?.(e);
    const promptPreview = allowsLangfuseContentProjection(
      phaseTrace?.correlation.captureProfile ?? "metadata-v1",
    )
      ? boundRedactedContent(prompt, MAX_LANGFUSE_CONTENT_CHARS).text
      : undefined;

    await emitPromptProvenanceEvent(
      runDirectory,
      telemetryCorrelation,
      {
        ...promptProvenance,
        promptName: promptNameForPhase("code_review"),
        promptAssemblySchemaVersion: 1,
        renderedPromptPreview: promptPreview,
        promptProvider: skillInjection.assembly.provider,
        promptSource: skillInjection.assembly.source,
        providerPromptVersion: skillInjection.assembly.providerPromptVersion,
        providerLabel: skillInjection.assembly.providerLabel,
        providerTemplateSha256: skillInjection.assembly.providerTemplateSha256,
        localTemplateSha256: skillInjection.assembly.localTemplateSha256,
        fallbackUsed: skillInjection.assembly.fallbackUsed,
        fallbackReason: skillInjection.assembly.fallbackReason,
        skillInvocationMode: skillInjection.assembly.skillInvocationMode,
        langfusePromptLinked: skillInjection.assembly.langfusePromptLinked,
        langfusePromptJson: skillInjection.langfusePromptLinkJson,
        nativeCapabilityState: skillInjection.assembly.nativeCapabilityState,
        componentOrdering: skillInjection.assembly.componentOrdering,
        variablesUsed: skillInjection.assembly.variablesUsed,
      },
      onTelemetry,
    );
    await emitSkillProvenanceEvent(
      runDirectory,
      telemetryCorrelation,
      {
        ...skillProvenance,
        skillsUsed: skillInjection.skillsUsed.map((s) => ({
          skillId: s.skillId,
          sourcePath: s.sourcePath,
          role: s.role,
          contentSha256: s.contentSha256,
          inclusionMethod: s.inclusionMethod,
          discovered: s.discovered,
          invoked: s.invoked,
          evidenceSource: s.evidenceSource,
          fallbackReason: s.fallbackReason,
        })),
        skillProvenanceStatus: skillInjection.skillProvenanceStatus,
      },
      onTelemetry,
    );

    captureWorkflowAnalyticsEvent(
      "p_dev_workflow_transition",
      buildWorkflowAnalyticsProperties({
        workflow_schema_version: readiness.workflowSchemaVersion,
        workflow_phase_id: "code_review",
        status_before: issue.status ?? undefined,
        transition_reason: "code_review_started",
        optional_phase_enabled: true,
        cycle_name: "code_review_cycles",
        cycle_count: state.cycleCounters.code_review_cycles ?? 0,
        cycle_limit: freeze.cycleLimit,
        workflow_state_revision: state.stateRevision,
      }),
    );

    const agent = await createCodeReviewAgent({
      apiKey: cursorApiKey,
      config,
      targetRepo: resolved.targetRepo,
      branch: branchName || `pr-${latestImplementation.prNumber}`,
      prUrl: latestImplementation.prUrl,
    });

    try {
      const timeoutMs =
        (config.planning?.timeoutSeconds ?? DEFAULT_PLANNING_TIMEOUT_SECONDS) *
        1000;
      reviewerObs =
        phaseTrace?.startChild(
          agentObservationDisplayName({
            issueKey: issue.identifier,
            role: "code_reviewer",
          }),
          "agent",
        ) ?? null;

      const observeWithTimeout = (message: string) =>
        Promise.race([
          sendAndObserve(agent, message, runDirectory, events, {
            apiKey: cursorApiKey,
            phase: "code_review",
            telemetryCorrelation,
            onTelemetryEvent: onTelemetry,
            targetRepo: resolved.targetRepo,
            expectedPrUrl: latestImplementation.prUrl,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new CodeReviewError(
                  "cursor_run_timeout",
                  `Cursor code review run exceeded ${timeoutMs / 1000}s`,
                ),
              );
            }, timeoutMs);
          }),
        ]);

      let observed = await observeWithTimeout(prompt);
      cursorAgentId = observed.agentId;
      cursorRunId = observed.runId;
      await mkdir(path.join(runDirectory, "outputs"), { recursive: true });
      const resultPath = getCodeReviewResultPath(runDirectory);
      await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");

      const downloadedArtifacts = await downloadAgentReviewArtifacts(agent);
      const primaryArtifact = selectPrimaryReviewArtifact(downloadedArtifacts);
      if (primaryArtifact) {
        await writeFile(
          path.join(runDirectory, "outputs", "code-review-artifact.md"),
          `${primaryArtifact.text}\n`,
          "utf8",
        );
      }

      const expectedCodeIdentity = {
        prNumber: latestImplementation.prNumber,
        headSha: latestImplementation.headSha,
        diffHash: latestImplementation.diffHash,
      };
      let extraction = extractReviewDecision({
        kind: "code_review",
        rawResponse: observed.assistantText,
        artifactText: primaryArtifact?.text ?? null,
        artifactIdentity: primaryArtifact?.path ?? null,
        expectedCodeIdentity,
      });
      let repairTurnCount = 0;

      if (!extraction.ok || !extraction.codeOutcome) {
        await events.log("cursor_event", "warn", {
          phase: "code_review",
          event: "decision_repair_attempt",
          priorFailure: extraction.failureClassification ?? "decision_unresolved",
          extractionSource: extraction.source,
        });
        const repairObs =
          phaseTrace?.startChild("p-dev.code-review.decision-repair", "generation") ??
          null;
        observed = await observeWithTimeout(REVIEW_DECISION_REPAIR_PROMPT);
        cursorAgentId = observed.agentId;
        cursorRunId = observed.runId;
        await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");
        extraction = extractReviewDecisionAfterRepair({
          prior: extraction,
          repairResponse: observed.assistantText,
          kind: "code_review",
          expectedCodeIdentity,
        });
        repairTurnCount = extraction.repairTurnCount ?? 1;
        repairObs?.end({
          metadata: {
            repairTurnCount,
            extractionSource: extraction.source,
            decision: extraction.decision ?? null,
            failureClassification: extraction.failureClassification ?? null,
          },
        });
      }

      const outputRef = await buildArtifactRef({
        runDirectory,
        absolutePath: resultPath,
        artifactKind: "agent_output",
      });

      if (!extraction.ok || !extraction.codeOutcome || !extraction.decision) {
        reviewerObs?.end({
          metadata: {
            modelId: observed.model?.id ?? model,
            modelRole: "code_reviewer",
            schemaFailure:
              extraction.failureClassification ?? "decision_unresolved",
            extractionSource: extraction.source,
            artifactUsed: Boolean(primaryArtifact),
            repairTurnCount,
          },
        });
        const failure =
          extraction.failureClassification ?? "decision_unresolved";
        throw new CodeReviewError(
          failure === "decision_unresolved"
            ? "decision_unresolved"
            : "validation_failed",
          `Code Review decision could not be parsed: ${failure}`,
        );
      }

      await events.log("code_review_decision_extracted", "info", {
        extractionSource: extraction.source,
        decision: extraction.decision,
        artifactUsed: Boolean(primaryArtifact),
        artifactIdentity: primaryArtifact?.path ?? null,
        repairTurnCount,
        attempts: extraction.attempts,
        promptVersion: CODE_REVIEW_PROMPT_VERSION,
      });

      const validated = { ok: true as const, outcome: extraction.codeOutcome };

      const reviewCycle =
        state.cycleCounters.code_review_cycles ?? 0;
      const review = toEngineCodeReviewOutcome({
        codeReview: validated.outcome,
        reviewerGenerationId: runId,
        expectedStateRevision: latestImplementation.workflowStateRevision,
        issueKey: options.issueKey,
        reviewCycle,
      });

      const applied = await applyPhaseTransition({
        store,
        issueKey: options.issueKey,
        config,
        expectedStateRevision: state.stateRevision,
        currentPhaseId: "code_review",
        codeReviewEffectiveEnabled: true,
        linearStatuses,
        phaseExecutionFreeze: freeze,
        latestImplementationArtifact: recoveredImplementationArtifact
          ? latestImplementation
          : undefined,
        outcome: {
          kind: "review",
          phaseId: "code_review",
          attemptIdentity: review.decisionIdentity,
          review,
          generationId: review.generationId,
        },
        evidence: {
          linearStatusName: issue.status ?? readiness.codeReviewStatusName,
          latestPrNumber: latestImplementation.prNumber,
          latestHeadSha: latestImplementation.headSha,
          latestBaseSha: latestImplementation.baseSha,
          latestDiffHash: latestImplementation.diffHash,
          latestImplementationGenerationId:
            latestImplementation.implementationGenerationId,
          latestImplementationWorkflowStateRevision:
            latestImplementation.workflowStateRevision,
        },
        clearActiveRunId: runId,
      });

      if (applied.reason === "duplicate_transition") {
        await events.log("idempotency_skip", "info", {
          reason: "code_review_duplicate_transition",
          reviewSubjectIdentity,
        });
        finalOutcome = "duplicate";
        errorClassification = "duplicate_phase_completed";
        ownedActiveClaim = false;
      } else if (!applied.applyOk || !applied.statusName) {
        throw new CodeReviewError(
          "linear_write_failure",
          `Code Review transition rejected: ${applied.reason}`,
        );
      } else {
      const commentBody = formatCodeReviewComment({
        outcome: validated.outcome,
        footer: {
          orchestratorMarker: config.orchestratorMarker,
          phase: "code_review",
          runId,
          model,
          promptVersion: version,
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
          decisionIdentity: review.decisionIdentity,
          reviewedPrNumber: validated.outcome.reviewedPrNumber,
          reviewedHeadSha: validated.outcome.reviewedHeadSha,
          reviewedDiffHash: validated.outcome.reviewedDiffHash,
          codeReviewCycle:
            applied.state?.cycleCounters.code_review_cycles ??
            state.cycleCounters.code_review_cycles ??
            0,
          codeReviewCycleLimit: freeze.cycleLimit,
        },
      });
      const { findCodeReviewCommentByDecision } = await import(
        "../../linear/code-review-comment.js"
      );
      const existingDecisionComment = findCodeReviewCommentByDecision(
        comments,
        config.orchestratorMarker,
        review.decisionIdentity,
      );
      if (!existingDecisionComment) {
        await postIssueComment(client, issue.id, commentBody);
      } else {
        await events.log("idempotency_skip", "info", {
          reason: "duplicate_code_review_decision_comment",
          decisionIdentity: review.decisionIdentity,
        });
      }
      await transitionIssueStatus(client, issue, applied.statusName);
      linearStatusAfter = applied.statusName;

      if (review.decision === "approved" && applied.statusName) {
        const existingComments = await listIssueComments(client, issue.id);
        const alreadyPosted = existingComments.some((comment) =>
          hasPmHandoffMarker(comment.body, reviewSubjectIdentity),
        );
        if (!alreadyPosted) {
          const pmBody = buildHandoffCommentBody({
            prTitle: `PR #${latestImplementation.prNumber}`,
            prUrl: latestImplementation.prUrl,
            branch: branchName || `pr-${latestImplementation.prNumber}`,
            targetRepo: markerTargetRepo,
            baseBranch: resolved.baseBranch,
            previewUrl: null,
            previewWarning: null,
            changedFiles: [],
            checkSummary: "See Code Review decision above.",
            harnessRunId: runId,
            previousImplementationRunId: latestImplementation.builderRunId,
            subjectIdentity: reviewSubjectIdentity,
          });
          await postHandoffComment(client, issue.id, pmBody, {
            orchestratorMarker: config.orchestratorMarker,
            phase: "handoff",
            runId,
            model,
            promptVersion: "handoff@1",
            targetRepo: resolved.targetRepo,
            baseBranch: resolved.baseBranch,
            prUrl: latestImplementation.prUrl,
            prNumber: String(latestImplementation.prNumber),
            prHeadSha: latestImplementation.headSha,
            diffHash: latestImplementation.diffHash,
            handoffSubjectIdentity: reviewSubjectIdentity,
          });
        }
      }

      const decisionType = applied.result?.decisionType ?? review.decision;
      captureWorkflowAnalyticsEvent(
        "p_dev_workflow_transition",
        buildWorkflowAnalyticsProperties({
          workflow_schema_version: readiness.workflowSchemaVersion,
          workflow_phase_id: "code_review",
          status_after: applied.statusName,
          transition_reason: applied.result?.reason,
          optional_phase_enabled: true,
          decision_type: decisionType,
          cycle_name: "code_review_cycles",
          cycle_count: applied.state?.cycleCounters.code_review_cycles ?? 0,
          cycle_limit: freeze.cycleLimit,
          workflow_state_revision: applied.stateRevision ?? undefined,
        }),
      );
      if (
        review.decision === "needs_revision" &&
        applied.result?.reason === "review_needs_revision"
      ) {
        captureWorkflowAnalyticsEvent(
          "p_dev_review_cycle_incremented",
          buildWorkflowAnalyticsProperties({
            workflow_schema_version: readiness.workflowSchemaVersion,
            workflow_phase_id: "code_review",
            cycle_name: "code_review_cycles",
            cycle_count: applied.state?.cycleCounters.code_review_cycles ?? 0,
            cycle_limit: freeze.cycleLimit,
            decision_type: "needs_revision",
          }),
        );
      }
      if (applied.result?.reason === "cycle_limit_reached") {
        captureWorkflowAnalyticsEvent(
          "p_dev_cycle_limit_reached",
          buildWorkflowAnalyticsProperties({
            workflow_schema_version: readiness.workflowSchemaVersion,
            workflow_phase_id: "code_review",
            cycle_name: "code_review_cycles",
            cycle_count: applied.state?.cycleCounters.code_review_cycles ?? 0,
            cycle_limit: freeze.cycleLimit,
            decision_type: "escalation",
          }),
        );
      }

      const endMeta = {
        modelId: observed.model?.id ?? model,
        modelRole: "code_reviewer",
        promptName: promptNameForPhase("code_review"),
        agentRole: "code_reviewer",
        decision: review.decision,
        reviewedPrNumber: latestImplementation.prNumber,
        reviewedHeadSha: latestImplementation.headSha,
        agentOutputSha256: outputRef?.sha256 ?? null,
        ...agentObsMetadataFromObserved({
          ...observed,
          requestedModel: {
            id: reviewerModel.model,
            params: reviewerModel.modelParams ?? undefined,
            parameterEvidenceSource: reviewerModel.parameterEvidenceSource,
            providerDefaultParams: reviewerModel.providerDefaultParams,
            harnessDefaultParams: reviewerModel.harnessDefaultParams,
          },
        }),
      };
      reviewerObs?.end(endMeta);
      extraEvalMetadata = endMeta;
      finalOutcome = "success";
      errorClassification = null;
      } // end non-duplicate transition path
    } finally {
      await disposeAgent(agent);
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    if (error instanceof CodeReviewError) {
      errorClassification = error.classification;
    } else {
      errorClassification = classifyUnexpectedPhaseError(error);
    }
    await events.log("phase_error", "error", {
      message,
      errorClassification,
    });
    if (finalOutcome !== "duplicate" && ownedActiveClaim) {
      try {
        await postErrorComment(
          client,
          issue.id,
          message,
          {
            orchestratorMarker: config.orchestratorMarker,
            phase: "code_review",
            runId,
            model,
            promptVersion: promptVersion ?? "code-review@1",
            targetRepo: resolved.targetRepo,
            baseBranch: resolved.baseBranch,
            cursorAgentId: cursorAgentId ?? undefined,
            cursorRunId: cursorRunId ?? undefined,
            prUrl: latestImplementation.prUrl,
          },
          "code_review",
        );
      } catch {
        // best-effort
      }
    }
    if (finalOutcome !== "duplicate") {
      finalOutcome = "failed";
    }
  }

  const afterIssue = await fetchLinearIssue(options.issueKey, linearApiKey);
  await mkdir(path.join(runDirectory, "linear"), { recursive: true });
  await writeFile(
    getIssueSnapshotAfterPath(runDirectory),
    `${JSON.stringify(afterIssue, null, 2)}\n`,
    "utf8",
  );

  const manifest: RunManifest = {
    runId,
    issueKey: options.issueKey,
    phase: "code_review",
    phaseInferredFromStatus: issue.status,
    linearStatusBefore: issue.status,
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
    promptVersion,
    cursorAgentId,
    cursorRunId,
    branch: null,
    prUrl: latestImplementation.prUrl,
    previewUrl: null,
    validationSummary: null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: latestImplementation.builderRunId,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
    deliveryId,
    runGeneration,
    runOwnedStatuses: linearStatusAfter ? [linearStatusAfter] : [],
  };
  await writeManifest(runDirectory, manifest);
  await writeRunSummary(runDirectory, manifest, parsed, resolved);
  const finalManifest = await finalizePhaseEvaluation({
    runtime: options.evaluationRuntime,
    phaseTrace,
    manifest,
    runDirectory,
    extraMetadata: extraEvalMetadata,
  });

  return {
    manifest: finalManifest,
    runDirectory,
    exitCode:
      finalOutcome === "success" || finalOutcome === "duplicate" ? 0 : 1,
  };
}
