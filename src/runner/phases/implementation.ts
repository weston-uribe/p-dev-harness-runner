import { mkdir, writeFile } from "node:fs/promises";
import {
  DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
  DEFAULT_PREVIEW_POLL_INTERVAL_SECONDS,
  DEFAULT_PREVIEW_POLL_TIMEOUT_SECONDS,
  IMPLEMENTATION_PROMPT_VERSION,
  MILESTONE,
} from "../../config/defaults.js";
import { resolveNextStatusName } from "../workflow-transition.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getImplementationPromptPath,
  getImplementationResultPath,
  getIssueSnapshotAfterPath,
  getPlanningCommentLoadedPath,
  getPrMetadataPath,
} from "../../artifacts/paths.js";
import { writeCommentsArtifact } from "../../linear/comments.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { resolveOptionalPlanningContext } from "../../linear/planning-comment.js";
import {
  createLinearClient,
  listIssueComments,
  postErrorComment,
  postPhaseStartCommentIfNeeded,
  transitionIssueStatus,
  type LinearCommentRecord,
} from "../../linear/writer.js";
import {
  claimAgentRun,
  DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
} from "../../workflow/state/index.js";
import type { WorkflowStateRecord } from "../../workflow/state/types.js";
import { resolveDefinitionForConfig } from "../workflow-transition.js";
import { resolveImplementationSubject } from "../../workflow/resolve-implementation-subject.js";
import {
  buildImplementationDispatchEffectId,
  buildImplementationRequestId,
} from "../../workflow/implementation-dispatch-effect.js";
import { markImplementationDispatchCompleted } from "../../workflow/state/side-effects.js";
import {
  acquireBuilderAgent,
  disposeAgent,
  sendAndObserve,
  type CursorCancelOutcome,
} from "../../agents/production.js";
import { buildPhaseLaunchContext } from "../provenance-launch-context.js";
import type { LinearHarnessLaunchContext } from "../../provenance/launch-context.js";
import { manifestModelEvidence, resolveBuilderModel } from "../../cursor/model.js";
import { assertPrBaseBranchMatches } from "../../github/base-branch.js";
import { GitHubClient } from "../../github/client.js";
import { classifyGitHubError, inspectPullRequest } from "../../github/pr-inspector.js";
import { parsePrUrl } from "../../github/pr-url.js";
import { pollForVercelPreview } from "../../preview/vercel-from-pr.js";
import { shouldCaptureApplicationPreview } from "../../preview/preview-capability.js";
import { buildBranchName } from "../../prompts/branch-name.js";
import { buildImplementationPrompt } from "../../prompts/builder.js";
import { buildImplementationIdempotencyKey } from "../builder-thread-idempotency.js";
import {
  builderManifestFieldsFromResolution,
  builderMarkerEvidenceFromResolution,
} from "../builder-thread-evidence.js";
import type { BuilderThreadResolution } from "../builder-thread-types.js";
import { ImplementationError } from "../errors.js";
import {
  classifyUnexpectedPhaseError,
  extractErrorMessage,
  isStaleEligibilitySkip,
} from "../classify-phase-error.js";
import { blocksDirectImplementationForInitialization } from "../../product/initialization-state.js";
import { runPreflight } from "../preflight.js";
import { rerouteUninitializedProductToPlanning } from "../uninitialized-product-routing.js";
import {
  assertImplementationEligibleStatus,
  checkImplementationIdempotency,
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
  NestedObservationHandle,
  PhaseTraceHandle,
} from "../../evaluation/types.js";
import {
  extractAllowlistedCursorUsage,
} from "../../evaluation/capture-policy.js";
import {
  finalizePhaseEvaluation,
  safeStartPhaseTrace,
} from "../../evaluation/phase-helpers.js";
import { agentObservationDisplayName } from "../../evaluation/naming.js";
import { promptNameForPhase } from "../../prompts/skill-inject.js";
import { assembleAgentPrompt } from "../../prompts/assemble.js";
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
import { completenessToMetadata } from "../../evaluation/telemetry/completeness.js";
import { allowsLangfuseContentProjection } from "../../evaluation/telemetry/profiles.js";
import { boundRedactedContent } from "../../evaluation/telemetry/redact.js";
import { MAX_LANGFUSE_CONTENT_CHARS } from "../../evaluation/telemetry/bounds.js";
import { buildArtifactRef } from "../../evaluation/telemetry/artifact-ref.js";

export interface ImplementationPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface ImplementationPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ImplementationError(
      name === "LINEAR_API_KEY" ? "linear_auth_failure" : "cursor_api_failure",
      `${name} is required for live implementation runs`,
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
  cursorCleanup: CursorCancelOutcome | null = null,
  phaseTrace: PhaseTraceHandle | null = null,
  extraEvalMetadata?: Record<string, unknown>,
  evaluationRuntime: EvaluationRuntime | null = null,
): Promise<ImplementationPhaseResult> {
  const finalManifest = await finalizePhaseEvaluation({
    runtime: evaluationRuntime,
    phaseTrace,
    manifest,
    runDirectory,
    extraMetadata: extraEvalMetadata,
  });

  if (runDirectory) {
    await writeManifest(runDirectory, finalManifest);
    await writeRunSummary(runDirectory, finalManifest, parsed, resolved, {
      cursorCleanup,
    });
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
            "base_branch_missing",
            "wrong_pr_base_branch",
          ].includes(errorClassification)
        ? 2
        : 3;

  return { manifest: finalManifest, runDirectory, exitCode };
}

export async function executeImplementationPhase(
  options: ImplementationPhaseOptions,
): Promise<ImplementationPhaseResult> {
  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const cursorApiKey = requireEnv("CURSOR_API_KEY");

  const preflight = await runPreflight({
    issueKey: options.issueKey,
    configPath: options.configPath,
    linearApiKey,
  });

  let phaseTrace: PhaseTraceHandle | null = null;

  if (!preflight.success) {
    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "implementation",
      issueKey: options.issueKey,
      runId: preflight.runId,
      metadata: {
        resolutionSource: preflight.resolved?.resolutionSource ?? null,
        baseBranch: preflight.resolved?.baseBranch ?? null,
        repositoryConfigurationId: preflight.resolved?.repoConfigId ?? null,
        linearStatusBefore: preflight.issue?.status ?? null,
      },
    });
    const preflightObs = phaseTrace?.startChild("p-dev.preflight", "span");
    preflightObs?.end({
      finalOutcome: "failed",
      errorClassification: preflight.errorClassification,
    });
    const manifest: RunManifest = {
      runId: preflight.runId,
      issueKey: options.issueKey,
      phase: preflight.phase,
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
      model: preflight.config
        ? manifestModelEvidence(preflight.config, "builder").model
        : null,
      modelRole: preflight.config ? "builder" : null,
      modelParams: preflight.config
        ? manifestModelEvidence(preflight.config, "builder").modelParams
        : null,
    };
    return writeFinalManifest(
      manifest,
      preflight.runDirectory,
      preflight.parsed,
      preflight.resolved,
      preflight.events,
      "failed",
      preflight.errorClassification,
      null,
      phaseTrace,
    );
  }

  const {
    config,
    issue,
    parsed,
    resolved,
    productInitialization,
    runId,
    runDirectory,
    events,
    phase,
    phaseInferredFromStatus,
    startedAt,
  } = preflight.context;

  phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
    phase: "implementation",
    issueKey: options.issueKey,
    runId,
    metadata: {
      resolutionSource: resolved.resolutionSource,
      baseBranch: resolved.baseBranch,
      repositoryConfigurationId: resolved.repoConfigId,
      linearStatusBefore: issue.status,
      promptContractVersion: IMPLEMENTATION_PROMPT_VERSION,
      modelId: manifestModelEvidence(config, "builder").model,
      modelRole: "builder",
      modelParams: manifestModelEvidence(config, "builder").modelParams,
    },
  });
  const preflightObs = phaseTrace?.startChild("p-dev.preflight", "span");
  preflightObs?.end({
    finalOutcome: "success",
    resolutionSource: resolved.resolutionSource,
  });

  const linearStatusBefore = issue.status;
  let linearStatusAfter = issue.status;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = null;
  let cursorAgentId: string | null = null;
  let cursorRunId: string | null = null;
  let branch: string | null = null;
  let prUrl: string | null = null;
  let previewUrl: string | null = null;
  let validationSummary: string | null = null;
  let enteredBuilding = false;
  let cursorCleanup: CursorCancelOutcome | null = null;
  let builderContinuity: BuilderThreadResolution | null = null;
  let cursorRequestId: string | null = null;
  let planningContextPresent = false;
  let planningHistory:
    | {
        directBuild: boolean;
        planningRequested: boolean;
      }
    | null = null;
  const builderModel = manifestModelEvidence(config, "builder");
  const model = builderModel.model;
  const commentsWritten: string[] = [];
  const branchName = buildBranchName(issue.identifier, issue.title, config);

  const footerBase = {
    orchestratorMarker: config.orchestratorMarker,
    phase: "implementation",
    runId,
    model,
    promptVersion: IMPLEMENTATION_PROMPT_VERSION,
    targetRepo: resolved.targetRepo,
    baseBranch: resolved.baseBranch,
  };

  const client = createLinearClient(linearApiKey);

  try {
    const reroute = await rerouteUninitializedProductToPlanning({
      config,
      issue,
      targetRepo: resolved.targetRepo,
      productInitialization,
      linearApiKey,
      linearClient: client,
    });
    if (reroute.rerouted) {
      await events.log("uninitialized_product_rerouted", "info", {
        planningStatus: reroute.planningStatus,
        commentId: reroute.commentId,
      });
      finalOutcome = "skipped";
      errorClassification = "wrong_status";
      const manifest: RunManifest = {
        runId,
        issueKey: options.issueKey,
        phase,
        phaseInferredFromStatus,
        linearStatusBefore,
        linearStatusAfter: reroute.planningStatus ?? linearStatusBefore,
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
        prUrl: null,
        previewUrl: null,
        validationSummary: "Rerouted uninitialized product from Ready for Build to Ready for Planning.",
        changedFiles: null,
        checkSummary: null,
        previousImplementationRunId: null,
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
        null,
        phaseTrace,
      );
    }

    try {
      assertImplementationEligibleStatus(config, issue, Boolean(options.force));
    } catch (error) {
      throw new ImplementationError(
        "wrong_status",
        error instanceof Error ? error.message : String(error),
      );
    }

    let comments: LinearCommentRecord[] = [];
    try {
      comments = await listIssueComments(client, issue.id);
    } catch (error) {
      // Fail-open for optional planning + idempotency: empty comments means no
      // prior completion markers. Issue body from preflight remains authoritative.
      await events.log("planning_context_absent", "warn", {
        reason: "comment_lookup_failed",
        message: extractErrorMessage(error),
      });
      comments = [];
    }

    const githubForIdempotency = process.env.GITHUB_TOKEN
      ? new GitHubClient({ token: process.env.GITHUB_TOKEN })
      : undefined;
    const idempotency = await checkImplementationIdempotency(
      config,
      issue,
      comments,
      Boolean(options.force),
      githubForIdempotency
        ? {
            github: githubForIdempotency,
            targetRepo: resolved.targetRepo,
            baseBranch: resolved.baseBranch,
          }
        : undefined,
    );
    if (idempotency.skip) {
      await events.log("idempotency_skip", "info", { reason: idempotency.reason });
      finalOutcome = idempotency.recoveryHandoff ? "duplicate" : "duplicate";
      errorClassification = idempotency.recoveryHandoff
        ? "recovery_handoff"
        : idempotency.reason?.startsWith("implementation_in_progress")
          ? "implementation_in_progress"
          : "duplicate_phase_completed";
      if (idempotency.discoveredPrUrl) {
        prUrl = idempotency.discoveredPrUrl;
      }
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
        promptVersion: IMPLEMENTATION_PROMPT_VERSION,
        cursorAgentId,
        cursorRunId,
        branch,
        prUrl,
        previewUrl: null,
        validationSummary,
        changedFiles: null,
        checkSummary: null,
        previousImplementationRunId: null,
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
        null,
        phaseTrace,
      );
    }

    let supersededGenerationIds: string[] = [];
    let implementationSubjectIdentity: string | null = null;
    try {
      const resolvedSubject = await resolveImplementationSubject({
        config,
        issueKey: options.issueKey,
        linearApiKey,
      });
      implementationSubjectIdentity = resolvedSubject.subjectIdentity;
      const stateStore = resolvedSubject.stateStore;
      let workflowState = resolvedSubject.state;
      if (stateStore && workflowState) {
        supersededGenerationIds = [
          ...(workflowState.supersededGenerationIdentities ?? []),
        ];
        const hasCompletedPlan = Boolean(workflowState.latestPlanArtifact);
        const planningPhaseEvidence =
          hasCompletedPlan ||
          (workflowState.completedPhaseIdentities ?? []).some((identity) =>
            /planning/i.test(identity),
          ) ||
          (workflowState.currentPhaseId ?? "").toLowerCase().includes("planning");
        planningHistory = {
          directBuild: !hasCompletedPlan,
          planningRequested: planningPhaseEvidence,
        };

        if (workflowState.latestImplementationArtifact) {
          await events.log("idempotency_skip", "info", {
            reason: "implementation_subject_already_complete",
            implementationSubjectIdentity,
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
            promptVersion: IMPLEMENTATION_PROMPT_VERSION,
            cursorAgentId,
            cursorRunId,
            branch,
            prUrl,
            previewUrl: null,
            validationSummary,
            changedFiles: null,
            checkSummary: null,
            previousImplementationRunId: null,
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
            null,
            phaseTrace,
          );
        }

        const definition = resolveDefinitionForConfig({
          config,
          baseBranch: resolved.baseBranch,
          productionBranch: resolved.productionBranch,
        });
        const leaseIdentity = `implementation:${implementationSubjectIdentity}`;
        const claimResult = await claimAgentRun({
          store: stateStore,
          issueKey: options.issueKey,
          definition,
          expectedStateRevision: workflowState.stateRevision,
          currentPhaseId:
            workflowState.currentPhaseId ?? "implementation_dispatch",
          runId,
          evidence: {
            linearStatusName: issue.status ?? linearStatusBefore ?? "",
          },
          leaseIdentity,
          subjectIdentity: implementationSubjectIdentity,
          leaseTtlMs: DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
        });
        if (!claimResult.ok) {
          await events.log("idempotency_skip", "info", {
            reason: "implementation_claim_conflict",
            implementationSubjectIdentity,
            claimReason: claimResult.reason,
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
            promptVersion: IMPLEMENTATION_PROMPT_VERSION,
            cursorAgentId,
            cursorRunId,
            branch,
            prUrl,
            previewUrl: null,
            validationSummary,
            changedFiles: null,
            checkSummary: null,
            previousImplementationRunId: null,
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
            null,
            phaseTrace,
          );
        }
        workflowState = claimResult.state;
        // Persist subject on state for gate convergence.
        if (
          workflowState &&
          workflowState.implementationSubjectIdentity !==
            implementationSubjectIdentity
        ) {
          const next: WorkflowStateRecord = {
            ...workflowState,
            implementationSubjectIdentity,
            stateRevision: workflowState.stateRevision + 1,
          };
          const ok = await stateStore.compareAndSet({
            issueKey: options.issueKey,
            expectedRevision: workflowState.stateRevision,
            next,
          });
          if (ok) workflowState = next;
        }
      }
    } catch {
      planningHistory = null;
    }

    const planningResolution = resolveOptionalPlanningContext({
      comments,
      orchestratorMarker: config.orchestratorMarker,
      supersededGenerationIds,
    });
    const planningContext = planningResolution.context;
    planningContextPresent = Boolean(planningContext);

    if (
      blocksDirectImplementationForInitialization(productInitialization)
    ) {
      throw new ImplementationError(
        "wrong_status",
        "Target product is uninitialized — complete product foundation planning before implementation",
      );
    }

    if (planningContext) {
      await mkdir(`${runDirectory}/linear`, { recursive: true });
      await writeFile(
        getPlanningCommentLoadedPath(runDirectory),
        `${planningContext.body}\n`,
        "utf8",
      );
      await events.log("planning_comment_loaded", "info", {
        commentId: planningContext.commentId,
      });
    } else {
      await events.log("planning_context_absent", "info", {
        reason: planningResolution.reason,
      });
    }

    const buildingStatus = resolveNextStatusName({
      config,
      currentPhaseId: "implementation_dispatch",
      outcome: {
        kind: "claim",
        phaseId: "implementation_dispatch",
        attemptIdentity: runId,
      },
      evidence: { linearStatusName: issue.status ?? linearStatusBefore ?? "" },
    }).statusName;
    await transitionIssueStatus(client, issue, buildingStatus);
    enteredBuilding = true;
    linearStatusAfter = buildingStatus;
    await events.log("linear_status_changed", "info", {
      from: linearStatusBefore,
      to: buildingStatus,
    });
    phaseTrace
      ?.startChild("p-dev.linear.status-transition", "event")
      ?.end({
        linearStatusBefore,
        linearStatusAfter: buildingStatus,
      });

    const repoConfig = config.repos.find((repo) => repo.id === resolved.repoConfigId);
    const validationCommands = repoConfig?.validation?.commands ?? [];
    const { prompt: basePrompt } = await buildImplementationPrompt({
      issue,
      parsed,
      resolved,
      runId,
      branchName,
      planningCommentBody: planningContext?.body ?? null,
      validationCommands,
      productInitializationState: productInitialization.state,
    });
    const skillInjection = await assembleAgentPrompt({
      phase: "implementation",
      localCompiledPrompt: basePrompt,
    });
    const prompt = skillInjection.prompt;

    await mkdir(`${runDirectory}/prompts`, { recursive: true });
    const promptPath = getImplementationPromptPath(runDirectory);
    await writeFile(promptPath, `${prompt}\n`, "utf8");

    const telemetryCorrelation = buildTelemetryCorrelation({
      namespace: options.evaluationRuntime?.namespace ?? "default",
      issueKey: issue.identifier,
      harnessRunId: runId,
      phase: "implementation",
      providerTraceId: phaseTrace?.correlation.traceId,
    });
    const promptProvenance = await buildPromptProvenance({
      runDirectory,
      promptContractVersion: IMPLEMENTATION_PROMPT_VERSION,
      promptTemplatePath: "src/prompts/implementation.md",
      renderedPromptAbsolutePath: promptPath,
    });
    const declaredSkills = skillInjection.skillsUsed.map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
    }));
    const skillProvenance = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.implementation ?? [],
      declared: declaredSkills,
      observed: declaredSkills,
    });
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
        promptName: promptNameForPhase("implementation"),
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
      (e) => phaseTrace?.onTelemetryEvent?.(e),
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
      (e) => phaseTrace?.onTelemetryEvent?.(e),
    );
    if (
      phaseTrace &&
      allowsLangfuseContentProjection(phaseTrace.correlation.captureProfile)
    ) {
      const bounded = boundRedactedContent(prompt, MAX_LANGFUSE_CONTENT_CHARS);
      phaseTrace.setIO?.(
        {
          task: parsed.task,
          acceptanceCriteria: parsed.acceptanceCriteria,
          promptPreview: bounded.text,
        },
        undefined,
      );
    } else {
      phaseTrace?.setIO?.(
        {
          promptTemplateSha256: promptProvenance.promptTemplateSha256,
          renderedPromptSha256:
            promptProvenance.renderedPromptArtifact?.sha256 ?? null,
          renderedPromptByteCount:
            promptProvenance.renderedPromptArtifact?.byteCount ?? null,
        },
        undefined,
      );
    }

    const implementationIdempotencyKey = buildImplementationIdempotencyKey({
      issueKey: issue.identifier,
      targetRepo: resolved.targetRepo,
      branch: branchName,
    });
    const acquired = await acquireBuilderAgent({
      apiKey: cursorApiKey,
      config,
      phase: "implementation",
      events,
      context: {
        issueKey: issue.identifier,
        harnessRunId: runId,
        targetRepo: resolved.targetRepo,
        baseBranch: resolved.baseBranch,
        branch: branchName,
        idempotencyKey: implementationIdempotencyKey,
        comments,
        orchestratorMarker: config.orchestratorMarker,
      },
      buildLaunchContext: (info) =>
        buildPhaseLaunchContext({
          config,
          linearIssueId: issue.id,
          linearIssueKey: issue.identifier,
          phase: "implementation",
          phaseExecutionId: runId,
          harnessRunId: runId,
          agentRole: "builder",
          action: info.action,
          generation: info.generation,
          priorAgentId: info.priorAgentId,
          targetRepository: resolved.targetRepo,
          startingRef: branchName || resolved.baseBranch,
          launchSurface: info.launchSurface,
        }),
    });
    builderContinuity = acquired.continuity;
    const builderEvidence = builderMarkerEvidenceFromResolution(
      acquired.continuity,
      implementationIdempotencyKey,
    );
    const agent = acquired.agent;
    cursorAgentId = acquired.continuity.reference.agentId;
    const implementationAction =
      acquired.continuity.action === "created"
        ? ("create" as const)
        : acquired.continuity.action === "resumed"
          ? ("resume" as const)
          : ("replacement" as const);
    const implementationLaunchContext: LinearHarnessLaunchContext =
      buildPhaseLaunchContext({
        config,
        linearIssueId: issue.id,
        linearIssueKey: issue.identifier,
        phase: "implementation",
        phaseExecutionId: runId,
        harnessRunId: runId,
        agentRole: "builder",
        action: implementationAction,
        generation: acquired.continuity.reference.generation,
        priorAgentId: acquired.continuity.previousAgentId,
        targetRepository: resolved.targetRepo,
        startingRef: branchName || resolved.baseBranch,
        launchSurface:
          implementationAction === "create"
            ? "implementation.initial_create"
            : implementationAction === "resume"
              ? "implementation.resume"
              : "implementation.replacement",
      });

    // Persist builder identity so racing gates no-op before a second agent starts.
    if (implementationSubjectIdentity && acquired.continuity.reference.agentId) {
      try {
        const resolvedSubject = await resolveImplementationSubject({
          config,
          issueKey: options.issueKey,
          linearApiKey,
        });
        if (resolvedSubject.stateStore && resolvedSubject.state) {
          const effectId = buildImplementationDispatchEffectId(
            implementationSubjectIdentity,
          );
          const requestId = buildImplementationRequestId(
            implementationSubjectIdentity,
          );
          const withBuilder: WorkflowStateRecord = {
            ...resolvedSubject.state,
            implementationSubjectIdentity,
            builderAgentId: acquired.continuity.reference.agentId,
            builderRunId: runId,
          };
          const next = {
            ...markImplementationDispatchCompleted(withBuilder, {
              identity: effectId,
              reviewRequestId: requestId,
            }),
            stateRevision: resolvedSubject.state.stateRevision + 1,
          };
          await resolvedSubject.stateStore.compareAndSet({
            issueKey: options.issueKey,
            expectedRevision: resolvedSubject.state.stateRevision,
            next,
          });
        }
      } catch {
        // Best-effort; lease already held.
      }
    }

    try {
    const timeoutMs =
      (config.implementation?.timeoutSeconds ??
        DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS) * 1000;

    const abortController = new AbortController();
    let timeoutError: ImplementationError | null = null;
    const timeoutId = setTimeout(() => {
      timeoutError = new ImplementationError(
        "cursor_run_timeout",
        `Cursor implementation run exceeded ${timeoutMs / 1000}s`,
      );
      abortController.abort(timeoutError);
    }, timeoutMs);

    let observed;
    const builderObs: NestedObservationHandle | undefined =
      phaseTrace?.startChild(
        agentObservationDisplayName({
          issueKey: issue.identifier,
          role: "implementer",
        }),
        "agent",
      );
    if (
      builderObs &&
      phaseTrace &&
      allowsLangfuseContentProjection(phaseTrace.correlation.captureProfile)
    ) {
      builderObs.update({
        input: boundRedactedContent(prompt, MAX_LANGFUSE_CONTENT_CHARS).text,
        metadata: {
          promptContractVersion: IMPLEMENTATION_PROMPT_VERSION,
          promptTemplateSha256: promptProvenance.promptTemplateSha256,
        },
      });
    } else {
      builderObs?.update({
        promptContractVersion: IMPLEMENTATION_PROMPT_VERSION,
        promptTemplateSha256: promptProvenance.promptTemplateSha256,
        renderedPromptSha256:
          promptProvenance.renderedPromptArtifact?.sha256 ?? null,
      });
    }
    try {
      observed = await sendAndObserve(agent, prompt, runDirectory, events, {
        phase: "implementation",
        launchContext: implementationLaunchContext,
        sendSurface: "implementation.send",
        sendOrdinal: 1,
        targetRepo: resolved.targetRepo,
        abortSignal: abortController.signal,
        apiKey: cursorApiKey,
        model: resolveBuilderModel(config),
        mode: "agent",
        idempotencyKey: implementationIdempotencyKey,
        telemetryCorrelation,
        onTelemetryEvent: (e) => phaseTrace?.onTelemetryEvent?.(e),
        onBeforeSend: async ({ agentId }) => {
          const commentId = await postPhaseStartCommentIfNeeded(client, issue.id, {
            orchestratorMarker: config.orchestratorMarker,
            phase: "implementation_start",
            runId,
            issueKey: issue.identifier,
            targetRepo: resolved.targetRepo,
            baseBranch: resolved.baseBranch,
            model,
            promptVersion: IMPLEMENTATION_PROMPT_VERSION,
            branch: branchName,
            cursorAgentId: agentId,
            builderAgentId: builderEvidence.builderAgentId,
            builderThreadGeneration: builderEvidence.builderThreadGeneration,
            builderThreadAction: builderEvidence.builderThreadAction,
            builderOriginRunId: builderEvidence.builderOriginRunId,
            builderThreadIdempotencyKey: builderEvidence.builderThreadIdempotencyKey,
            previousBuilderAgentId: builderEvidence.previousBuilderAgentId,
            builderThreadReplacementReason:
              builderEvidence.builderThreadReplacementReason,
          });
          if (commentId) {
            await events.log("phase_start_comment_posted", "info", {
              phase: "implementation_start",
              commentId,
            });
            await events.log("linear_comment_posted", "info", {
              phase: "implementation_start",
              commentId,
            });
          }
        },
        onAgentCreated: async ({ agentId, runId: createdRunId }) => {
          await events.log("builder_followup_run_started", "info", {
            agentId,
            runId: createdRunId,
            phase: "implementation",
          });
        },
      });
      const outputPath = getImplementationResultPath(runDirectory);
      await mkdir(`${runDirectory}/outputs`, { recursive: true });
      await writeFile(outputPath, `${observed.assistantText}\n`, "utf8");
      const outputRef = await buildArtifactRef({
        runDirectory,
        absolutePath: outputPath,
        artifactKind: "agent_output",
      });
      const endMeta = {
        modelId: observed.model?.id ?? model,
        modelRole: "builder",
        modelParams: builderModel.modelParams,
        builderThreadAction: builderEvidence.builderThreadAction,
        builderThreadGeneration: builderEvidence.builderThreadGeneration,
        builderReplacementReason: builderEvidence.builderThreadReplacementReason,
        prCreated: Boolean(observed.gitResult?.prUrl),
        promptTemplateSha256: promptProvenance.promptTemplateSha256,
        agentOutputSha256: outputRef?.sha256 ?? null,
        agentOutputByteCount: outputRef?.byteCount ?? null,
        ...extractAllowlistedCursorUsage(
          observed.usage as
            | import("../../evaluation/capture-policy.js").CursorUsageInput
            | undefined,
        ),
        ...agentObsMetadataFromObserved({
          ...observed,
          requestedModel: {
            id: builderModel.model,
            params: builderModel.modelParams ?? undefined,
            parameterEvidenceSource: builderModel.parameterEvidenceSource,
            providerDefaultParams: builderModel.providerDefaultParams,
            harnessDefaultParams: builderModel.harnessDefaultParams,
          },
        }),
        ...(observed.completeness
          ? completenessToMetadata(observed.completeness)
          : {}),
      };
      if (
        phaseTrace &&
        allowsLangfuseContentProjection(phaseTrace.correlation.captureProfile)
      ) {
        builderObs?.end({
          output: boundRedactedContent(
            observed.assistantText,
            MAX_LANGFUSE_CONTENT_CHARS,
          ).text,
          metadata: endMeta,
          model: observed.model?.id ?? model,
          usageDetails: {
            ...(typeof observed.usage?.inputTokens === "number"
              ? { input: observed.usage.inputTokens }
              : {}),
            ...(typeof observed.usage?.outputTokens === "number"
              ? { output: observed.usage.outputTokens }
              : {}),
            ...(typeof observed.usage?.totalTokens === "number"
              ? { total: observed.usage.totalTokens }
              : {}),
          },
        });
        phaseTrace.setIO?.(undefined, {
          assistantPreview: boundRedactedContent(
            observed.assistantText,
            MAX_LANGFUSE_CONTENT_CHARS,
          ).text,
          prCreated: Boolean(observed.gitResult?.prUrl),
        });
      } else {
        builderObs?.end(endMeta);
      }
    } catch (error) {
      builderObs?.end({
        cursorStatus: "error",
        builderThreadAction: builderEvidence.builderThreadAction,
      });
      if (abortController.signal.aborted && timeoutError) {
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    cursorCleanup = observed.cancelOutcome;

    cursorAgentId = observed.agentId;
    cursorRunId = observed.runId;
    cursorRequestId = observed.requestId ?? null;
    branch = observed.gitResult?.branch ?? null;
    prUrl = observed.gitResult?.prUrl ?? null;
    validationSummary = observed.assistantText;

    await mkdir(`${runDirectory}/github`, { recursive: true });
    await writeFile(
      getPrMetadataPath(runDirectory),
      `${JSON.stringify(
        {
          repoUrl: observed.gitResult?.repoUrl ?? resolved.targetRepo,
          branch,
          prUrl,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await events.log("git_result_captured", "info", {
      targetRepo: resolved.targetRepo,
      branch,
      prUrl,
    });
    await events.log("pr_captured", "info", { prUrl });

    if (process.env.GITHUB_TOKEN && prUrl) {
      const parsedPr = parsePrUrl(prUrl);
      if (!parsedPr) {
        throw new ImplementationError("missing_pr_url", `Invalid PR URL: ${prUrl}`);
      }
      const github = new GitHubClient({ token: process.env.GITHUB_TOKEN });
      const prValidationObs = phaseTrace?.startChild(
        "p-dev.github.pr-validation",
        "span",
      );
      try {
        const inspection = await inspectPullRequest(
          github,
          parsedPr,
          resolved.targetRepo,
        );
        assertPrBaseBranchMatches({
          prUrl,
          actualBaseBranch: inspection.baseBranch,
          expectedBaseBranch: resolved.baseBranch,
        });
        prValidationObs?.end({
          prCreated: true,
          baseBranch: resolved.baseBranch,
        });

        const pollTimeout =
          config.preview?.pollTimeoutSeconds ?? DEFAULT_PREVIEW_POLL_TIMEOUT_SECONDS;
        const pollInterval =
          config.preview?.pollIntervalSeconds ?? DEFAULT_PREVIEW_POLL_INTERVAL_SECONDS;

        if (shouldCaptureApplicationPreview(resolved.previewProvider)) {
          const previewObs = phaseTrace?.startChild("p-dev.preview", "span");
          const previewResult = await pollForVercelPreview(
            async () => {
              const latest = await inspectPullRequest(github, parsedPr, resolved.targetRepo);
              return latest.comments;
            },
            {
              pollTimeoutSeconds: pollTimeout,
              pollIntervalSeconds: pollInterval,
            },
          );
          if (previewResult.previewUrl) {
            previewUrl = previewResult.previewUrl;
            await events.log("preview_captured", "info", {
              previewUrl,
              source: previewResult.source,
              phase: "implementation",
            });
            previewObs?.end({
              previewConfigured: true,
              previewAvailable: true,
            });
          } else {
            await events.log("preview_not_found", "warn", {
              warnings: previewResult.warnings,
              phase: "implementation",
            });
            previewObs?.end({
              previewConfigured: true,
              previewAvailable: false,
            });
          }
        } else {
          await events.log("application_preview_not_configured", "info", {
            previewProvider: resolved.previewProvider,
            phase: "implementation",
          });
        }
      } catch (error) {
        prValidationObs?.end({
          prCreated: Boolean(prUrl),
          finalOutcome: "failed",
        });
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("wrong_pr_base_branch")) {
          throw new ImplementationError("wrong_pr_base_branch", message);
        }
        throw new ImplementationError(classifyGitHubError(error), message);
      }
    }

    await events.log("validation_completed", "info", { validationSummary });

    const prOpenStatus = resolveNextStatusName({
      config,
      currentPhaseId: "implementation",
      outcome: {
        kind: "success",
        phaseId: "implementation",
        attemptIdentity: runId,
      },
      evidence: { linearStatusName: buildingStatus },
    }).statusName;
    await transitionIssueStatus(client, issue, prOpenStatus);
    linearStatusAfter = prOpenStatus;
    await events.log("linear_status_changed", "info", {
      from: buildingStatus,
      to: prOpenStatus,
    });
    phaseTrace
      ?.startChild("p-dev.linear.status-transition", "event")
      ?.end({
        linearStatusBefore: buildingStatus,
        linearStatusAfter: prOpenStatus,
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
    } finally {
      await disposeAgent(agent);
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    if (error instanceof ImplementationError) {
      errorClassification = error.classification;
      cursorCleanup = error.cancelOutcome;
    } else {
      errorClassification = classifyUnexpectedPhaseError(error);
    }
    validationSummary = validationSummary ?? message;
    await events.log("phase_error", "error", {
      message,
      errorClassification,
      enteredBuilding,
    });
    await writeErrorArtifact(runDirectory, message, errorClassification);

    if (isStaleEligibilitySkip(error, enteredBuilding)) {
      finalOutcome = "skipped";
      await events.log("stale_eligibility_skip", "info", {
        reason: message,
        status: linearStatusAfter,
      });
    } else if (enteredBuilding) {
      try {
        await postErrorComment(client, issue.id, message, {
          ...footerBase,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
          branch: branch ?? undefined,
          prUrl: prUrl ?? undefined,
        }, "implementation");
        const blocked = resolveNextStatusName({
          config,
          currentPhaseId: "implementation",
          outcome: {
            kind: "failure",
            phaseId: "implementation",
            attemptIdentity: `${runId}:failure`,
          },
          evidence: { linearStatusName: linearStatusAfter ?? "Building" },
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
    promptVersion: IMPLEMENTATION_PROMPT_VERSION,
    cursorAgentId,
    cursorRunId,
    branch,
    prUrl,
    previewUrl,
    validationSummary,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
    modelRole: "builder",
    modelParams: builderModel.modelParams,
    ...(builderContinuity
      ? builderManifestFieldsFromResolution(builderContinuity, cursorRequestId ?? undefined)
      : {
          builderAgentId: null,
          builderThreadAction: null,
          builderThreadGeneration: null,
          builderOriginRunId: null,
          previousBuilderAgentId: null,
          builderThreadReplacementReason: null,
          cursorRequestId: cursorRequestId,
        }),
  };

  const planningEvalMetadata: Record<string, unknown> = {
    route: "implementation",
    planning_context_present: planningContextPresent,
  };
  if (planningHistory) {
    planningEvalMetadata.direct_build = planningHistory.directBuild;
    if (planningHistory.planningRequested) {
      planningEvalMetadata.planning_requested = true;
    }
  }

  return writeFinalManifest(
    manifest,
    runDirectory,
    parsed,
    resolved,
    events,
    finalOutcome,
    errorClassification,
    cursorCleanup,
    phaseTrace,
    {
      totalPhaseDurationMs: Date.now() - startedAt.getTime(),
      modelId: model,
      modelRole: "builder",
      modelParams: builderModel.modelParams,
      cursorAgentId,
      cursorRunId,
      cursorRequestId,
      builderThreadAction: builderContinuity?.action ?? null,
      builderThreadGeneration: builderContinuity?.reference.generation ?? null,
      previewConfigured: shouldCaptureApplicationPreview(resolved.previewProvider),
      ...planningEvalMetadata,
    },
    options.evaluationRuntime ?? null,
  );
}
