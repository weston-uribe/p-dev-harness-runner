import { resolvePhaseWorkflowStateStore } from "../../workflow/state/resolve-store.js";
import { buildPlanReviewSubjectIdentity } from "../../workflow/subject-identities.js";
import {
  ensurePlanReviewDispatchPending,
  ensurePlanReviewJobDispatched,
  MISSING_PLAN_REVIEW_DISPATCH_TOKEN_MESSAGE,
} from "../../workflow/plan-review-dispatch-effect.js";
import { mkdir, writeFile } from "node:fs/promises";
import {
  DEFAULT_PLANNING_TIMEOUT_SECONDS,
  MILESTONE,
} from "../../config/defaults.js";
import { resolveNextStatusName } from "../workflow-transition.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getIssueSnapshotAfterPath,
  getPlanningPromptPath,
  getPlanningResultPath,
} from "../../artifacts/paths.js";
import { writeCommentsArtifact } from "../../linear/comments.js";
import { fetchLinearIssue } from "../../linear/client.js";
import {
  createLinearClient,
  listIssueComments,
  postErrorComment,
  postPhaseStartCommentIfNeeded,
  postPlanningComment,
  transitionIssueStatus,
} from "../../linear/writer.js";
import {
  createPlanningAgent,
  disposeAgent,
  sendAndObserve,
} from "../../agents/index.js";
import { manifestModelEvidence } from "../../cursor/model.js";
import { buildPlanningPrompt } from "../../prompts/builder.js";
import { PlanningError } from "../errors.js";
import {
  classifyUnexpectedPhaseError,
  extractErrorMessage,
  isStaleEligibilitySkip,
} from "../classify-phase-error.js";
import { runPreflight } from "../preflight.js";
import { resolveRunGeneration } from "../run-generation.js";
import { updateRunStatusPhase } from "../../linear/run-status-comment.js";
import {
  assertPlanningEligibleStatus,
  checkPlanningIdempotency,
} from "../idempotency.js";
import type { EventLogger } from "../../artifacts/events.js";
import type {
  ErrorClassification,
  FinalOutcome,
  RunManifest,
} from "../../types/run.js";
import type { ParsedIssue } from "../../types/parsed-issue.js";
import type { ResolvedTarget } from "../../resolver/target-repo.js";
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
import type { EvaluationRuntime, NestedObservationHandle, PhaseTraceHandle } from "../../evaluation/types.js";
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

export interface PlanningPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface PlanningPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new PlanningError(
      name === "LINEAR_API_KEY" ? "linear_auth_failure" : "cursor_api_failure",
      `${name} is required for live planning runs`,
    );
  }
  return value;
}

async function writeFinalManifest(
  manifest: RunManifest,
  runDirectory: string,
  parsed: ParsedIssue,
  resolved: ResolvedTarget | null,
  events: EventLogger | null,
  finalOutcome: FinalOutcome,
  errorClassification: ErrorClassification,
  evaluationRuntime: EvaluationRuntime | null = null,
  phaseTrace: PhaseTraceHandle | null = null,
  extraEvalMetadata?: Record<string, unknown>,
): Promise<PlanningPhaseResult> {
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
      : finalOutcome === "failed" && !errorClassification
        ? 2
        : errorClassification &&
            ["ambiguous_issue", "missing_target_repo", "unknown_repo_denied"].includes(
              errorClassification,
            ) ||
            errorClassification === "base_branch_missing"
          ? 2
          : 3;

  return { manifest: finalManifest, runDirectory, exitCode };
}

export async function executePlanningPhase(
  options: PlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const cursorApiKey = requireEnv("CURSOR_API_KEY");

  const preflight = await runPreflight({
    issueKey: options.issueKey,
    configPath: options.configPath,
    linearApiKey,
  });

  if (!preflight.success) {
    const isDuplicateDelivery =
      preflight.errorClassification === "duplicate_delivery";
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
      finalOutcome: isDuplicateDelivery ? "duplicate" : "failed",
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
        ? manifestModelEvidence(preflight.config, "planner").model
        : null,
      modelRole: preflight.config ? "planner" : null,
      modelParams: preflight.config
        ? manifestModelEvidence(preflight.config, "planner").modelParams
        : null,
      deliveryId: process.env.LINEAR_DELIVERY_ID ?? null,
      runGeneration: resolveRunGeneration(),
      runOwnedStatuses: preflight.issue?.status ? [preflight.issue.status] : null,
    };
    return writeFinalManifest(
      manifest,
      preflight.runDirectory,
      preflight.parsed,
      preflight.resolved,
      preflight.events,
      isDuplicateDelivery ? "duplicate" : "failed",
      preflight.errorClassification,
    );
  }

  const {
    config,
    issue: preflightIssue,
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

  let issue = preflightIssue;
  const linearStatusBefore = issue.status;
  let linearStatusAfter = issue.status;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = null;
  let validationSummary: string | null = null;
  let cursorAgentId: string | null = null;
  let cursorRunId: string | null = null;
  let promptVersion: string | null = null;
  const plannerModel = manifestModelEvidence(config, "planner");
  const model = plannerModel.model;
  let enteredPlanning = false;
  const commentsWritten: string[] = [];
  let phaseTrace: PhaseTraceHandle | null = null;
  let plannerObs: NestedObservationHandle | null = null;
  let extraEvalMetadata: Record<string, unknown> | undefined;

  const footerBase = {
    orchestratorMarker: config.orchestratorMarker,
    phase: "planning",
    runId,
    model,
    promptVersion: "planning@1",
    targetRepo: resolved.targetRepo,
    baseBranch: resolved.baseBranch,
  };

  const deliveryId = process.env.LINEAR_DELIVERY_ID ?? null;
  const runGeneration = resolveRunGeneration();
  let runOwnedStatuses = [linearStatusBefore].filter(Boolean) as string[];

  const client = createLinearClient(linearApiKey);

  try {
    const freshIssue = await fetchLinearIssue(options.issueKey, linearApiKey);
    issue = freshIssue;
    linearStatusAfter = freshIssue.status;
    runOwnedStatuses = [linearStatusBefore, freshIssue.status].filter(Boolean) as string[];

    const comments = await listIssueComments(client, issue.id);
    let allowPlanningInProgressForRevision = false;
    try {
      const { recoverPlanReviewRevisionFromComments } = await import(
        "../../workflow/recover-plan-review-decision.js"
      );
      allowPlanningInProgressForRevision = Boolean(
        recoverPlanReviewRevisionFromComments({
          comments,
          orchestratorMarker: config.orchestratorMarker,
        }),
      );
    } catch {
      allowPlanningInProgressForRevision = false;
    }

    try {
      assertPlanningEligibleStatus(config, freshIssue, Boolean(options.force), {
        allowPlanningInProgressForRevision,
      });
    } catch (error) {
      throw new PlanningError(
        "wrong_status",
        error instanceof Error ? error.message : String(error),
      );
    }
    const idempotency = checkPlanningIdempotency(
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
        promptVersion,
        cursorAgentId,
        cursorRunId,
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
        model,
        deliveryId,
        runGeneration,
        runOwnedStatuses,
      };
      return writeFinalManifest(
        manifest,
        runDirectory,
        parsed,
        resolved,
        events,
        finalOutcome,
        errorClassification,
      );
    }

    const planningClaim = resolveNextStatusName({
      config,
      currentPhaseId: "planning_dispatch",
      outcome: {
        kind: "claim",
        phaseId: "planning_dispatch",
        attemptIdentity: runId,
      },
      evidence: { linearStatusName: issue.status ?? linearStatusBefore ?? "" },
    });
    const planningStatus = planningClaim.statusName;
    await transitionIssueStatus(client, issue, planningStatus);
    enteredPlanning = true;
    linearStatusAfter = planningStatus;
    runOwnedStatuses = [...runOwnedStatuses, planningStatus];
    await events.log("linear_status_changed", "info", {
      from: linearStatusBefore,
      to: planningStatus,
    });

    await updateRunStatusPhase(client, issue.id, {
      phase: planningStatus,
      headline: "Planning in progress",
      runId,
      deliveryId,
      generation: runGeneration,
    });

    const { loadOrBootstrapWorkflowState: loadPlanningState } =
      await import("../../workflow/state/index.js");
    const planningStateStore = await resolvePhaseWorkflowStateStore({
      config,
      logDirectory: config.logDirectory ?? "runs",
    });
    const planningWorkflowState = await loadPlanningState({
      store: planningStateStore,
      issueKey: options.issueKey,
      workflowSchemaVersion: "product-development-v2",
      currentPhaseId: "planning",
    });
    let priorPlanBody = "_Prior plan unavailable._";
    let recoveredRevision: Awaited<
      ReturnType<
        typeof import("../../workflow/recover-plan-review-decision.js").recoverPlanReviewRevisionFromComments
      >
    > = null;
    const localNeedsPlanRevision =
      planningWorkflowState.returnDestination === "plan_review" &&
      Boolean(planningWorkflowState.latestPlanArtifact) &&
      planningWorkflowState.lastAcceptedReviewDecision?.decision ===
        "needs_revision";
    try {
      const priorComments = await listIssueComments(client, issue.id);
      if (!localNeedsPlanRevision) {
        const { recoverPlanReviewRevisionFromComments } = await import(
          "../../workflow/recover-plan-review-decision.js"
        );
        recoveredRevision = recoverPlanReviewRevisionFromComments({
          comments: priorComments,
          orchestratorMarker: config.orchestratorMarker,
        });
        if (recoveredRevision) {
          await events.log("planning_comment_loaded", "info", {
            source: "plan_review_revision_recovered_from_linear",
            decisionIdentity: recoveredRevision.decisionIdentity,
            blockingFindingCount: recoveredRevision.findings.filter(
              (f) => f.severity === "blocking",
            ).length,
          });
        }
      }
      const needsPlanBody =
        localNeedsPlanRevision || Boolean(recoveredRevision);
      if (needsPlanBody) {
        // Newest-first Linear lists: take the first ### Full plan match.
        const prior = priorComments.find((c) => c.body.includes("### Full plan"));
        if (prior) {
          const match = prior.body.match(
            /### Full plan\n([\s\S]*?)(?:\n<!--|\n---|\s*$)/,
          );
          priorPlanBody = match?.[1]?.trim() || prior.body;
        }
      }
    } catch {
      // best-effort
    }
    const needsPlanRevision =
      localNeedsPlanRevision || Boolean(recoveredRevision);
    const revisionFindings = localNeedsPlanRevision
      ? (planningWorkflowState.lastAcceptedReviewDecision?.findings ?? [])
      : (recoveredRevision?.findings ?? []);
    const revisionContext = needsPlanRevision
      ? {
          priorPlanBody,
          acceptedBlockingFindings: revisionFindings
            .filter((f) => f.severity === "blocking")
            .map((f) => ({
              id: f.id,
              category: f.category,
              evidence: f.evidence,
              requiredChange: f.requiredChange,
            })),
          planReviewCycle: localNeedsPlanRevision
            ? (planningWorkflowState.cycleCounters.plan_review_cycles ?? 0)
            : (recoveredRevision?.planReviewCycle ?? 1),
          planReviewCycleLimit: 4,
          causedByReviewDecisionIdentity: localNeedsPlanRevision
            ? (planningWorkflowState.lastAcceptedReviewDecision
                ?.decisionIdentity ?? null)
            : (recoveredRevision?.decisionIdentity ?? null),
        }
      : null;

    const { prompt: basePrompt, promptVersion: version } =
      await buildPlanningPrompt(issue, parsed, resolved, {
        productInitializationState: productInitialization.state,
        revision: revisionContext,
      });
    promptVersion = version;
    const { assembleAgentPrompt } = await import("../../prompts/assemble.js");
    const skillInjection = await assembleAgentPrompt({
      phase: "planning",
      localCompiledPrompt: basePrompt,
    });
    const prompt = skillInjection.prompt;
    await mkdir(`${runDirectory}/prompts`, { recursive: true });
    const planningPromptPath = getPlanningPromptPath(runDirectory);
    await writeFile(planningPromptPath, `${prompt}\n`, "utf8");

    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "planning",
      issueKey: issue.identifier,
      runId,
      linearTeamKey: issue.teamKey ?? null,
      metadata: {
        modelId: model,
        modelRole: "planner",
        promptContractVersion: version,
      },
    });

    const telemetryCorrelation = buildTelemetryCorrelation({
      namespace: options.evaluationRuntime?.namespace ?? "default",
      issueKey: issue.identifier,
      harnessRunId: runId,
      phase: "planning",
      providerTraceId: phaseTrace?.correlation.traceId,
    });
    const promptProvenance = await buildPromptProvenance({
      runDirectory,
      promptContractVersion: version,
      promptTemplatePath: "src/prompts/planning.md",
      renderedPromptAbsolutePath: planningPromptPath,
    });
    const declaredSkills = skillInjection.skillsUsed.map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
    }));
    const skillProvenance = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.planning ?? [],
      declared: declaredSkills,
      observed: declaredSkills,
    });
    const onTelemetry = (e: Parameters<NonNullable<PhaseTraceHandle["onTelemetryEvent"]>>[0]) =>
      phaseTrace?.onTelemetryEvent?.(e);
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
        promptName: promptNameForPhase("planning"),
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

    const agent = await createPlanningAgent({
      apiKey: cursorApiKey,
      config,
      targetRepo: resolved.targetRepo,
      baseBranch: resolved.baseBranch,
    });

    try {
    const timeoutMs =
      (config.planning?.timeoutSeconds ?? DEFAULT_PLANNING_TIMEOUT_SECONDS) *
      1000;

    plannerObs =
      phaseTrace?.startChild(
        agentObservationDisplayName({
          issueKey: issue.identifier,
          role: "planner",
        }),
        "agent",
      ) ?? null;
    if (plannerObs && promptPreview) {
      plannerObs.update({
        input: promptPreview,
        metadata: {
          promptName: promptNameForPhase("planning"),
          promptContractVersion: version,
          linearIssueKey: issue.identifier,
          agentRole: "planner",
        },
      });
    }

    let observed = await Promise.race([
      sendAndObserve(agent, prompt, runDirectory, events, {
        apiKey: cursorApiKey,
        phase: "planning",
        telemetryCorrelation,
        onTelemetryEvent: onTelemetry,
        onAgentCreated: async ({ agentId, runId: cursorRunId }) => {
          const commentId = await postPhaseStartCommentIfNeeded(client, issue.id, {
            orchestratorMarker: config.orchestratorMarker,
            phase: "planning_start",
            runId,
            issueKey: issue.identifier,
            targetRepo: resolved.targetRepo,
            baseBranch: resolved.baseBranch,
            model,
            promptVersion: version,
            cursorAgentId: agentId,
            cursorRunId,
          });
          if (commentId) {
            await events.log("phase_start_comment_posted", "info", {
              phase: "planning_start",
              commentId,
            });
            await events.log("linear_comment_posted", "info", {
              phase: "planning_start",
              commentId,
            });
          }
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new PlanningError(
              "cursor_run_timeout",
              `Cursor planning run exceeded ${timeoutMs / 1000}s`,
            ),
          );
        }, timeoutMs);
      }),
    ]);

    cursorAgentId = observed.agentId;
    cursorRunId = observed.runId;

    await mkdir(`${runDirectory}/outputs`, { recursive: true });
    const planningResultPath = getPlanningResultPath(runDirectory);
    await writeFile(
      planningResultPath,
      `${observed.assistantText}\n`,
      "utf8",
    );

    const { isImplementationReadyPlanBody } = await import(
      "../../workflow/plan-body-quality.js"
    );
    let planQuality = isImplementationReadyPlanBody(observed.assistantText);
    if (!planQuality.ok) {
      await events.log("cursor_event", "warn", {
        phase: "planning",
        event: "plan_body_quality_repair_attempt",
        reason: planQuality.reason,
      });
      const repairPrompt = [
        "Your previous reply was rejected as not implementation-ready.",
        `Reason: ${planQuality.reason}.`,
        "Reply again with the FULL implementation plan markdown now.",
        "Do not say you will create a plan later. Include Approach with numbered steps,",
        "files to touch, and an Acceptance Verification Plan section.",
      ].join(" ");
      observed = await Promise.race([
        sendAndObserve(agent, repairPrompt, runDirectory, events, {
          apiKey: cursorApiKey,
          phase: "planning",
          telemetryCorrelation,
          onTelemetryEvent: onTelemetry,
          targetRepo: resolved.targetRepo,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new PlanningError(
                "cursor_run_timeout",
                `Cursor planning repair exceeded ${timeoutMs / 1000}s`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      cursorAgentId = observed.agentId;
      cursorRunId = observed.runId;
      await writeFile(
        planningResultPath,
        `${observed.assistantText}\n`,
        "utf8",
      );
      planQuality = isImplementationReadyPlanBody(observed.assistantText);
    }
    if (!planQuality.ok) {
      throw new PlanningError(
        "validation_failed",
        `Planning output is not implementation-ready: ${planQuality.reason}`,
      );
    }

    const outputRef = await buildArtifactRef({
      runDirectory,
      absolutePath: planningResultPath,
      artifactKind: "agent_output",
    });
    const endMeta = {
      modelId: observed.model?.id ?? model,
      modelRole: "planner",
      promptName: promptNameForPhase("planning"),
      linearIssueKey: issue.identifier,
      agentRole: "planner",
      agentOutputSha256: outputRef?.sha256 ?? null,
      agentOutputByteCount: outputRef?.byteCount ?? null,
      ...agentObsMetadataFromObserved({
        ...observed,
        requestedModel: {
          id: plannerModel.model,
          params: plannerModel.modelParams ?? undefined,
          parameterEvidenceSource: plannerModel.parameterEvidenceSource,
          providerDefaultParams: plannerModel.providerDefaultParams,
          harnessDefaultParams: plannerModel.harnessDefaultParams,
        },
      }),
    };
    if (
      plannerObs &&
      phaseTrace &&
      allowsLangfuseContentProjection(phaseTrace.correlation.captureProfile)
    ) {
      plannerObs.end({
        output: boundRedactedContent(
          observed.assistantText,
          MAX_LANGFUSE_CONTENT_CHARS,
        ).text,
        metadata: endMeta,
        model: observed.model?.id ?? model,
      });
    } else {
      plannerObs?.end(endMeta);
    }
    extraEvalMetadata = endMeta;

    // Fail-closed Plan Review readiness: route only when effectively enabled.
    // Create immutable plan identity BEFORE posting the Linear comment so
    // plan_generation_id / plan_artifact_hash are durable across ephemeral GHA jobs.
    const { evaluatePlanReviewReadiness, buildPlanReviewReadinessDiagnostic } =
      await import("../../workflow/plan-review-readiness.js");
    const { createPlanArtifactIdentity } = await import(
      "../../workflow/plan-artifact.js"
    );
    const { loadOrBootstrapWorkflowState } =
      await import("../../workflow/state/index.js");
    const { applyPhaseTransition } = await import("../workflow-transition.js");
    const { captureWorkflowAnalyticsEvent, bypassEventToAnalytics } =
      await import("../../observability/workflow-analytics.js");
    const { listTeamWorkflowStates } = await import(
      "../../setup/linear-setup-client.js"
    );
    const { resolveAuthoritativeLinearTeamIdFromConfig } = await import(
      "../../config/resolve-linear-team.js"
    );

    let linearStatuses: Array<{ name: string; type: string }> = [];
    try {
      const teamId = resolveAuthoritativeLinearTeamIdFromConfig(config);
      if (teamId) {
        linearStatuses = await listTeamWorkflowStates(client, teamId);
      }
    } catch {
      linearStatuses = [];
    }
    const readiness = await evaluatePlanReviewReadiness({
      config,
      linearStatuses,
      issueKey: options.issueKey,
    });
    if (readiness.requestedEnabled && !readiness.effectiveEnabled) {
      const diag = buildPlanReviewReadinessDiagnostic({
        readiness,
        configurationSurface: "runner",
      });
      captureWorkflowAnalyticsEvent(diag.event, diag.properties);
      await events.log("plan_review_setup_required", "warn", {
        missingRequirements: readiness.missingRequirements,
      });
    }

    const logDirectory = config.logDirectory ?? "runs";
    const store = await resolvePhaseWorkflowStateStore({
    config,
    logDirectory,
  });
    const priorState = await loadOrBootstrapWorkflowState({
      store,
      issueKey: options.issueKey,
      workflowSchemaVersion: readiness.workflowSchemaVersion,
      enabledOptionalPhases: {
        planReview: readiness.requestedEnabled,
        codeReview: false,
      },
      effectiveOptionalPhases: {
        planReview: readiness.effectiveEnabled,
        codeReview: false,
      },
      currentPhaseId: "planning",
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: observed.assistantText,
      plannerRunId: runId,
      promptContractVersion: version,
      workflowStateRevision: priorState.stateRevision + 1,
      supersedesPlanGenerationId:
        priorState.latestPlanArtifact?.planGenerationId ?? null,
      causedByReviewDecisionIdentity:
        priorState.returnDestination === "plan_review"
          ? priorState.lastAcceptedReviewDecision?.decisionIdentity ?? null
          : null,
    });

    const planningComment = await postPlanningComment(
      client,
      issue.id,
      observed.assistantText,
      {
        ...footerBase,
        promptVersion: version,
        cursorAgentId,
        cursorRunId,
        planGenerationId: planArtifact.planGenerationId,
        planArtifactHash: planArtifact.planArtifactHash,
      },
      { planReviewNext: readiness.effectiveEnabled },
    );
    commentsWritten.push(observed.assistantText);
    await events.log("linear_comment_posted", "info", {
      phase: "planning",
      commentId: planningComment,
      planGenerationId: planArtifact.planGenerationId,
      planArtifactHash: planArtifact.planArtifactHash,
    });

    const applied = await applyPhaseTransition({
      store,
      issueKey: options.issueKey,
      config,
      expectedStateRevision: priorState.stateRevision,
      currentPhaseId: "planning",
      planReviewEffectiveEnabled: readiness.effectiveEnabled,
      latestPlanArtifact: planArtifact,
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: runId,
        generationId: planArtifact.planGenerationId,
      },
      evidence: { linearStatusName: planningStatus },
    });

    const planningSuccess = applied.applyOk && applied.statusName
      ? {
          statusName: applied.statusName,
          result: applied.result!,
          bypass: applied.result?.bypass ?? null,
        }
      : resolveNextStatusName({
          config,
          currentPhaseId: "planning",
          planReviewEffectiveEnabled: readiness.effectiveEnabled,
          outcome: {
            kind: "success",
            phaseId: "planning",
            attemptIdentity: runId,
          },
          evidence: { linearStatusName: planningStatus },
        });

    const nextStatus = planningSuccess.statusName;
    const landsOnPlanReview =
      readiness.effectiveEnabled &&
      nextStatus.trim().toLowerCase() === "plan review";

    let durableState = applied.state ?? priorState;
    let planReviewSubjectIdentity: string | null = null;
    if (landsOnPlanReview) {
      const reviewCycle = durableState.cycleCounters.plan_review_cycles ?? 0;
      planReviewSubjectIdentity = buildPlanReviewSubjectIdentity({
        issueKey: options.issueKey,
        planGenerationId: planArtifact.planGenerationId,
        planHash: planArtifact.planArtifactHash,
        reviewCycle,
      });
      // Crash boundary: pending effect before Linear projection.
      durableState = await ensurePlanReviewDispatchPending({
        store,
        issueKey: options.issueKey,
        reviewSubjectIdentity: planReviewSubjectIdentity,
        state: durableState,
      });
      await events.log("plan_review_dispatch_pending", "info", {
        planReviewSubjectIdentity,
        planGenerationId: planArtifact.planGenerationId,
        planArtifactHash: planArtifact.planArtifactHash,
      });
    }

    await transitionIssueStatus(client, issue, nextStatus);
    linearStatusAfter = nextStatus;
    await events.log("linear_status_changed", "info", {
      from: planningStatus,
      to: nextStatus,
      transitionReason: planningSuccess.result.reason,
      bypass: planningSuccess.bypass?.event ?? null,
      planGenerationId: planArtifact.planGenerationId,
      planArtifactHash: planArtifact.planArtifactHash,
      planReviewEffectiveEnabled: readiness.effectiveEnabled,
    });
    if (planningSuccess.bypass) {
      const bypassAnalytics = bypassEventToAnalytics(planningSuccess.bypass);
      captureWorkflowAnalyticsEvent(
        bypassAnalytics.event,
        bypassAnalytics.properties,
      );
    }

    if (landsOnPlanReview && planReviewSubjectIdentity) {
      const dispatchResult = await ensurePlanReviewJobDispatched({
        store,
        issueKey: options.issueKey,
        reviewSubjectIdentity: planReviewSubjectIdentity,
        ownerGeneration: runId,
        state: durableState,
      });
      durableState = dispatchResult.state;
      if (dispatchResult.outcome === "missing_dispatch_token") {
        throw new Error(MISSING_PLAN_REVIEW_DISPATCH_TOKEN_MESSAGE);
      }
      await events.log("plan_review_job_dispatched", "info", {
        planReviewSubjectIdentity,
        reviewRequestId: dispatchResult.reviewRequestId,
        outcome: dispatchResult.outcome,
        httpDispatched: dispatchResult.httpDispatched,
        planGenerationId: planArtifact.planGenerationId,
        planArtifactHash: planArtifact.planArtifactHash,
      });
    }

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
    if (error instanceof PlanningError) {
      errorClassification = error.classification;
    } else {
      errorClassification = classifyUnexpectedPhaseError(error);
    }
    validationSummary = message;
    await events.log("phase_error", "error", {
      message,
      errorClassification,
      enteredPlanning,
    });
    await writeErrorArtifact(runDirectory, message, errorClassification);

    if (isStaleEligibilitySkip(error, enteredPlanning)) {
      finalOutcome = "skipped";
      await events.log("stale_eligibility_skip", "info", {
        reason: message,
        status: linearStatusAfter,
      });
    } else if (enteredPlanning) {
      try {
        await postErrorComment(client, issue.id, message, {
          ...footerBase,
          promptVersion: promptVersion ?? "planning@1",
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
        });
        const blocked = resolveNextStatusName({
          config,
          currentPhaseId: "planning",
          outcome: {
            kind: "failure",
            phaseId: "planning",
            attemptIdentity: `${runId}:failure`,
          },
          evidence: { linearStatusName: linearStatusAfter ?? "Planning" },
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
    promptVersion,
    cursorAgentId,
    cursorRunId,
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
    modelRole: "planner",
    modelParams: plannerModel.modelParams,
    deliveryId,
    runGeneration,
    runOwnedStatuses,
  };

  return writeFinalManifest(
    manifest,
    runDirectory,
    parsed,
    resolved,
    events,
    finalOutcome,
    errorClassification,
    options.evaluationRuntime ?? null,
    phaseTrace,
    extraEvalMetadata,
  );
}
