/**
 * Plan Review phase — independent reviewer agent + fail-closed readiness.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@cursor/sdk";
import { DEFAULT_PLANNING_TIMEOUT_SECONDS, MILESTONE } from "../../config/defaults.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getIssueSnapshotAfterPath,
  getPlanReviewPromptPath,
  getPlanReviewResultPath,
  getRunDirectory,
} from "../../artifacts/paths.js";
import { EventLogger } from "../../artifacts/events.js";
import { fetchLinearIssue } from "../../linear/client.js";
import {
  createLinearClient,
  listIssueComments,
  postErrorComment,
  postIssueComment,
  transitionIssueStatus,
} from "../../linear/writer.js";
import { formatPlanReviewComment } from "../../linear/plan-review-comment.js";
import {
  createPlanReviewAgent,
  disposeAgent,
  downloadAgentReviewArtifacts,
  resumePlanReviewAgent,
  sendAndObserve,
} from "../../agents/production.js";
import { buildPhaseLaunchContext } from "../provenance-launch-context.js";
import type { LinearHarnessLaunchContext } from "../../provenance/launch-context.js";
import { selectPrimaryReviewArtifact } from "../../cursor/review-artifacts.js";
import { manifestModelEvidence } from "../../cursor/model.js";
import { buildPlanReviewPrompt } from "../../prompts/builder.js";
import { PlanReviewError } from "../errors.js";
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
  buildPhaseExecutionFreeze,
  buildPlanReviewReadinessDiagnostic,
  evaluatePlanReviewReadiness,
} from "../../workflow/plan-review-readiness.js";
import { toEngineReviewOutcome } from "../../workflow/review-contracts.js";
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

export interface PlanReviewPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface PlanReviewPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new PlanReviewError(
      name === "LINEAR_API_KEY" ? "linear_auth_failure" : "cursor_api_failure",
      `${name} is required for live plan review runs`,
    );
  }
  return value;
}

export async function executePlanReviewPhase(
  options: PlanReviewPhaseOptions,
): Promise<PlanReviewPhaseResult> {
  const startedAt = new Date();
  const runId = `plan-review-${startedAt.getTime()}`;
  const deliveryId = process.env.GITHUB_RUN_ID ?? runId;
  const runGeneration = resolveRunGeneration();
  let { config } = await loadHarnessConfig({ configPath: options.configPath });
  const logDirectory = config.logDirectory ?? "runs";
  const runDirectory = getRunDirectory(logDirectory, options.issueKey, runId);
  await mkdir(runDirectory, { recursive: true });
  const events = new EventLogger(runDirectory);
  await events.init();
  await events.log("run_started", "info", { phase: "plan_review", runId });

  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const cursorApiKey = requireEnv("CURSOR_API_KEY");
  const client = createLinearClient(linearApiKey);
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

  const reviewerModel = manifestModelEvidence(config, "planReviewer");
  const model = reviewerModel.model;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = "cursor_run_failed";
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

  const readiness = await evaluatePlanReviewReadiness({
    config,
    linearStatuses,
    issueKey: options.issueKey,
  });
  const readinessDiag = buildPlanReviewReadinessDiagnostic({
    readiness,
    configurationSurface: "runner",
  });
  captureWorkflowAnalyticsEvent(
    readinessDiag.event,
    readinessDiag.properties,
  );

  if (!readiness.effectiveEnabled) {
    await events.log("plan_review_not_effective", "warn", {
      requestedEnabled: readiness.requestedEnabled,
      missingRequirements: readiness.missingRequirements,
    });
    throw new PlanReviewError(
      "wrong_status",
      `Plan Review is not effectively enabled: ${readiness.missingRequirementMessages.join(" ")}`,
    );
  }

  let state = await loadOrBootstrapWorkflowState({
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
    currentPhaseId: "plan_review",
  });

  const freeze = state.phaseExecutionFreeze?.phaseId === "plan_review"
    ? state.phaseExecutionFreeze
    : buildPhaseExecutionFreeze({
        readiness,
        planReviewerModelId: reviewerModel.model,
        planReviewerFast:
          reviewerModel.effectiveVariant === "fast"
            ? true
            : reviewerModel.effectiveVariant === "standard"
              ? false
              : null,
      });

  if (!freeze.effectiveEnabled) {
    throw new PlanReviewError(
      "wrong_status",
      "Frozen phase execution has Plan Review effectiveEnabled=false",
    );
  }

  // Load comments first — plan identity may need durable Linear recovery when
  // ephemeral GHA runners do not share workflow-state.json across jobs.
  const comments = await listIssueComments(client, issue.id);
  let latestPlan = state.latestPlanArtifact;
  let recoveredPlanArtifact = false;
  if (!latestPlan) {
    const { recoverPlanArtifactFromPlanningComments } = await import(
      "../../workflow/recover-plan-artifact.js"
    );
    latestPlan = recoverPlanArtifactFromPlanningComments({
      comments,
      orchestratorMarker: config.orchestratorMarker,
    });
    if (latestPlan) {
      recoveredPlanArtifact = true;
      state = {
        ...state,
        latestPlanArtifact: latestPlan,
      };
      await events.log("plan_artifact_recovered_from_linear", "info", {
        planGenerationId: latestPlan.planGenerationId,
        planArtifactHash: latestPlan.planArtifactHash,
        plannerRunId: latestPlan.plannerRunId,
      });
    }
  }
  if (!latestPlan) {
    throw new PlanReviewError(
      "missing_plan_artifact",
      "No immutable plan artifact identity is available for Plan Review",
    );
  }

  const planBody =
    comments
      .slice()
      .reverse()
      .find((c) =>
        c.body.includes(latestPlan.planGenerationId) ||
        c.body.includes("### Full plan"),
      )?.body ??
    `_Plan generation ${latestPlan.planGenerationId} (hash ${latestPlan.planArtifactHash})_`;

  const previousFeedback =
    state.lastAcceptedReviewDecision?.decision === "needs_revision" &&
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

  try {
    const { prompt: basePrompt, promptVersion: version } =
      await buildPlanReviewPrompt({
        issue,
        parsed,
        planGenerationId: latestPlan.planGenerationId,
        planArtifactHash: latestPlan.planArtifactHash,
        plannerRunId: latestPlan.plannerRunId,
        planPromptContractVersion: latestPlan.promptContractVersion,
        planWorkflowStateRevision: latestPlan.workflowStateRevision,
        planBody,
        previousAcceptedFeedback: previousFeedback,
        planReviewCycle: state.cycleCounters.plan_review_cycles ?? 0,
        planReviewCycleLimit: freeze.cycleLimit,
      });
    promptVersion = version;
    const { assembleAgentPrompt } = await import("../../prompts/assemble.js");
    const skillInjection = await assembleAgentPrompt({
      phase: "plan_review",
      localCompiledPrompt: basePrompt,
    });
    const prompt = skillInjection.prompt;
    await mkdir(path.join(runDirectory, "prompts"), { recursive: true });
    const promptPath = getPlanReviewPromptPath(runDirectory);
    await writeFile(promptPath, `${prompt}\n`, "utf8");

    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "plan_review",
      issueKey: issue.identifier,
      runId,
      linearTeamKey: issue.teamKey ?? null,
      metadata: {
        modelId: model,
        modelRole: "plan_reviewer",
        promptContractVersion: version,
        reviewedPlanGenerationId: latestPlan.planGenerationId,
        reviewedPlanArtifactHash: latestPlan.planArtifactHash,
        planReviewCycle: state.cycleCounters.plan_review_cycles ?? 0,
        planReviewCycleLimit: freeze.cycleLimit,
      },
    });

    const telemetryCorrelation = buildTelemetryCorrelation({
      namespace: options.evaluationRuntime?.namespace ?? "default",
      issueKey: issue.identifier,
      harnessRunId: runId,
      phase: "plan_review",
      providerTraceId: phaseTrace?.correlation.traceId,
    });
    const promptProvenance = await buildPromptProvenance({
      runDirectory,
      promptContractVersion: version,
      promptTemplatePath: "src/prompts/plan-review.md",
      renderedPromptAbsolutePath: promptPath,
    });
    const declaredSkills = skillInjection.skillsUsed.map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
    }));
    const skillProvenance = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.plan_review ?? [],
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
        promptName: promptNameForPhase("plan_review"),
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
        workflow_phase_id: "plan_review",
        status_before: issue.status ?? undefined,
        transition_reason: "plan_review_started",
        optional_phase_enabled: true,
        cycle_name: "plan_review_cycles",
        cycle_count: state.cycleCounters.plan_review_cycles ?? 0,
        cycle_limit: freeze.cycleLimit,
        workflow_state_revision: state.stateRevision,
      }),
    );

    const reviewCycleForSubject = state.cycleCounters.plan_review_cycles ?? 0;
    const { buildPlanReviewSubjectIdentity } = await import(
      "../../workflow/subject-identities.js"
    );
    const planReviewSubjectIdentity =
      state.planReviewSubjectIdentity ??
      buildPlanReviewSubjectIdentity({
        issueKey: options.issueKey,
        planGenerationId: latestPlan.planGenerationId,
        planHash: latestPlan.planArtifactHash,
        reviewCycle: reviewCycleForSubject,
      });

    // Reuse an existing reviewer agent when durable state already has one.
    // On resume: reparse preserved raw/artifact first (FRE-8) — never a second
    // full Plan Review prompt unless the agent cannot be resumed.
    let agent;
    let reusedExistingReviewer = false;
    let planReviewLaunchContext: LinearHarnessLaunchContext;
    if (state.planReviewerAgentId) {
      try {
        planReviewLaunchContext = buildPhaseLaunchContext({
          config,
          linearIssueId: issue.id,
          linearIssueKey: issue.identifier,
          phase: "plan_review",
          phaseExecutionId: runId,
          harnessRunId: runId,
          agentRole: "plan_reviewer",
          action: "resume",
          generation: 1,
          priorAgentId: state.planReviewerAgentId,
          targetRepository: resolved.targetRepo,
          startingRef: resolved.baseBranch,
          launchSurface: "plan_review.resume",
        });
        agent = await resumePlanReviewAgent({
          apiKey: cursorApiKey,
          agentId: state.planReviewerAgentId,
          launchContext: planReviewLaunchContext,
        });
        reusedExistingReviewer = true;
        await events.log("plan_review_agent_reused", "info", {
          planReviewerAgentId: state.planReviewerAgentId,
          planReviewSubjectIdentity,
        });
      } catch (resumeError) {
        await events.log("plan_review_agent_resume_failed", "warn", {
          planReviewerAgentId: state.planReviewerAgentId,
          message:
            resumeError instanceof Error
              ? resumeError.message
              : String(resumeError),
        });
        planReviewLaunchContext = buildPhaseLaunchContext({
          config,
          linearIssueId: issue.id,
          linearIssueKey: issue.identifier,
          phase: "plan_review",
          phaseExecutionId: runId,
          harnessRunId: runId,
          agentRole: "plan_reviewer",
          action: "create",
          generation: 1,
          priorAgentId: state.planReviewerAgentId,
          targetRepository: resolved.targetRepo,
          startingRef: resolved.baseBranch,
          launchSurface: "plan_review.create",
          operationOrdinal: 2,
        });
        agent = await createPlanReviewAgent({
          apiKey: cursorApiKey,
          config,
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          launchContext: planReviewLaunchContext,
        });
      }
    } else {
      planReviewLaunchContext = buildPhaseLaunchContext({
        config,
        linearIssueId: issue.id,
        linearIssueKey: issue.identifier,
        phase: "plan_review",
        phaseExecutionId: runId,
        harnessRunId: runId,
        agentRole: "plan_reviewer",
        action: "create",
        generation: 1,
        targetRepository: resolved.targetRepo,
        startingRef: resolved.baseBranch,
        launchSurface: "plan_review.create",
      });
      agent = await createPlanReviewAgent({
        apiKey: cursorApiKey,
        config,
        targetRepo: resolved.targetRepo,
        baseBranch: resolved.baseBranch,
        launchContext: planReviewLaunchContext,
      });
    }

    try {
      const timeoutMs =
        (config.planning?.timeoutSeconds ?? DEFAULT_PLANNING_TIMEOUT_SECONDS) *
        1000;
      reviewerObs =
        phaseTrace?.startChild(
          agentObservationDisplayName({
            issueKey: issue.identifier,
            role: "plan_reviewer",
          }),
          "agent",
        ) ?? null;

      const observeWithTimeout = (message: string) =>
        Promise.race([
          sendAndObserve(agent, message, runDirectory, events, {
            apiKey: cursorApiKey,
            phase: "plan_review",
            launchContext: planReviewLaunchContext,
            telemetryCorrelation,
            onTelemetryEvent: onTelemetry,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new PlanReviewError(
                  "cursor_run_timeout",
                  `Cursor plan review run exceeded ${timeoutMs / 1000}s`,
                ),
              );
            }, timeoutMs);
          }),
        ]);

      const expectedPlanIdentity = {
        planGenerationId: latestPlan.planGenerationId,
        planArtifactHash: latestPlan.planArtifactHash,
      };
      await mkdir(path.join(runDirectory, "outputs"), { recursive: true });
      const resultPath = getPlanReviewResultPath(runDirectory);

      let observed: Awaited<ReturnType<typeof sendAndObserve>>;
      let repairTurnCount = 0;
      let primaryArtifact: ReturnType<typeof selectPrimaryReviewArtifact> = null;
      let extraction;

      if (reusedExistingReviewer) {
        cursorAgentId = state.planReviewerAgentId ?? null;
        cursorRunId = state.planReviewerRunId ?? null;
        let priorText = "";
        if (state.planReviewerAgentId && state.planReviewerRunId) {
          try {
            const priorRun = await Agent.getRun(state.planReviewerRunId, {
              runtime: "cloud",
              agentId: state.planReviewerAgentId,
              apiKey: cursorApiKey,
            });
            priorText = priorRun.result ?? "";
          } catch (priorError) {
            await events.log("plan_review_prior_run_fetch_failed", "warn", {
              planReviewerRunId: state.planReviewerRunId,
              message:
                priorError instanceof Error
                  ? priorError.message
                  : String(priorError),
            });
          }
        }
        await writeFile(resultPath, `${priorText}\n`, "utf8");
        const downloadedArtifacts = await downloadAgentReviewArtifacts(agent);
        primaryArtifact = selectPrimaryReviewArtifact(downloadedArtifacts);
        if (primaryArtifact) {
          await writeFile(
            path.join(runDirectory, "outputs", "plan-review-artifact.md"),
            `${primaryArtifact.text}\n`,
            "utf8",
          );
        }
        extraction = extractReviewDecision({
          kind: "plan_review",
          rawResponse: priorText,
          artifactText: primaryArtifact?.text ?? null,
          artifactIdentity: primaryArtifact?.path ?? null,
          expectedPlanIdentity,
        });
        await events.log("plan_review_reparse_attempt", "info", {
          extractionSource: extraction.source,
          decision: extraction.decision ?? null,
          artifactUsed: Boolean(primaryArtifact),
          priorTextLength: priorText.length,
        });

        if (!extraction.ok || !extraction.planOutcome) {
          await events.log("cursor_event", "warn", {
            phase: "plan_review",
            event: "decision_repair_attempt",
            priorFailure:
              extraction.failureClassification ?? "decision_unresolved",
            extractionSource: extraction.source,
            mode: "reused_reviewer",
          });
          const repairObs =
            phaseTrace?.startChild(
              "p-dev.plan-review.decision-repair",
              "generation",
            ) ?? null;
          observed = await observeWithTimeout(REVIEW_DECISION_REPAIR_PROMPT);
          cursorAgentId = observed.agentId;
          cursorRunId = observed.runId;
          await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");
          extraction = extractReviewDecisionAfterRepair({
            prior: extraction,
            repairResponse: observed.assistantText,
            kind: "plan_review",
            expectedPlanIdentity,
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
        } else {
          observed = {
            agentId: cursorAgentId ?? state.planReviewerAgentId ?? "unknown",
            runId: cursorRunId ?? state.planReviewerRunId ?? "reparse",
            assistantText: priorText,
            gitResult: null,
            cancelOutcome: null,
            model: { id: model },
          };
        }
      } else {
        observed = await observeWithTimeout(prompt);

        cursorAgentId = observed.agentId;
        cursorRunId = observed.runId;

        // Persist agent/run ids separately from dispatch subject (crash recovery).
        if (cursorAgentId || cursorRunId) {
          const withAgent = {
            ...state,
            planReviewSubjectIdentity,
            planReviewerAgentId: cursorAgentId ?? state.planReviewerAgentId,
            planReviewerRunId: cursorRunId ?? state.planReviewerRunId,
            stateRevision: state.stateRevision + 1,
          };
          const casOk = await store.compareAndSet({
            issueKey: options.issueKey,
            expectedRevision: state.stateRevision,
            next: withAgent,
          });
          if (casOk) {
            state = withAgent;
          }
          await events.log("plan_review_agent_persisted", "info", {
            planReviewSubjectIdentity,
            planReviewerAgentId: cursorAgentId,
            planReviewerRunId: cursorRunId,
            casOk,
          });
        }
        await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");

        const downloadedArtifacts = await downloadAgentReviewArtifacts(agent);
        primaryArtifact = selectPrimaryReviewArtifact(downloadedArtifacts);
        if (primaryArtifact) {
          await writeFile(
            path.join(runDirectory, "outputs", "plan-review-artifact.md"),
            `${primaryArtifact.text}\n`,
            "utf8",
          );
        }

        extraction = extractReviewDecision({
          kind: "plan_review",
          rawResponse: observed.assistantText,
          artifactText: primaryArtifact?.text ?? null,
          artifactIdentity: primaryArtifact?.path ?? null,
          expectedPlanIdentity,
        });

        if (!extraction.ok || !extraction.planOutcome) {
          await events.log("cursor_event", "warn", {
            phase: "plan_review",
            event: "decision_repair_attempt",
            priorFailure:
              extraction.failureClassification ?? "decision_unresolved",
            extractionSource: extraction.source,
          });
          const repairObs =
            phaseTrace?.startChild(
              "p-dev.plan-review.decision-repair",
              "generation",
            ) ?? null;
          observed = await observeWithTimeout(REVIEW_DECISION_REPAIR_PROMPT);
          cursorAgentId = observed.agentId;
          cursorRunId = observed.runId;
          await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");
          extraction = extractReviewDecisionAfterRepair({
            prior: extraction,
            repairResponse: observed.assistantText,
            kind: "plan_review",
            expectedPlanIdentity,
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
      }

      const outputRef = await buildArtifactRef({
        runDirectory,
        absolutePath: resultPath,
        artifactKind: "agent_output",
      });

      if (!extraction.ok || !extraction.planOutcome || !extraction.decision) {
        const failure =
          extraction.failureClassification ?? "decision_unresolved";
        reviewerObs?.end({
          metadata: {
            modelId: observed.model?.id ?? model,
            modelRole: "plan_reviewer",
            schemaFailure: failure,
            extractionSource: extraction.source,
            artifactUsed: Boolean(primaryArtifact),
            repairTurnCount,
            reparseOnly: reusedExistingReviewer,
          },
        });
        throw new PlanReviewError(
          failure === "decision_unresolved"
            ? "decision_unresolved"
            : "validation_failed",
          `Plan Review decision could not be parsed: ${failure}`,
        );
      }

      await events.log("plan_review_decision_extracted", "info", {
        extractionSource: extraction.source,
        decision: extraction.decision,
        artifactUsed: Boolean(primaryArtifact),
        artifactIdentity: primaryArtifact?.path ?? null,
        repairTurnCount,
        attempts: extraction.attempts,
        reparseOnly: reusedExistingReviewer && repairTurnCount === 0,
        promptVersion: version,
      });

      const validated = { ok: true as const, outcome: extraction.planOutcome };

      const reviewCycle =
        state.cycleCounters.plan_review_cycles ?? 0;
      const review = toEngineReviewOutcome({
        planReview: validated.outcome,
        reviewerGenerationId: runId,
        expectedStateRevision: latestPlan.workflowStateRevision,
        issueKey: options.issueKey,
        reviewCycle,
      });

      const applied = await applyPhaseTransition({
        store,
        issueKey: options.issueKey,
        config,
        expectedStateRevision: state.stateRevision,
        currentPhaseId: "plan_review",
        planReviewEffectiveEnabled: true,
        phaseExecutionFreeze: freeze,
        // Seed recovered identity into durable state for this job + future local use.
        latestPlanArtifact: recoveredPlanArtifact ? latestPlan : undefined,
        outcome: {
          kind: "review",
          phaseId: "plan_review",
          attemptIdentity: review.decisionIdentity,
          review,
          generationId: review.generationId,
        },
        evidence: {
          linearStatusName: issue.status ?? "Plan Review",
          latestPlanGenerationId: latestPlan.planGenerationId,
          latestPlanArtifactHash: latestPlan.planArtifactHash,
          latestPlanWorkflowStateRevision: latestPlan.workflowStateRevision,
        },
        clearActiveRunId: runId,
      });

      if (!applied.applyOk || !applied.statusName) {
        throw new PlanReviewError(
          "linear_write_failure",
          `Plan Review transition rejected: ${applied.reason}`,
        );
      }

      const commentBody = formatPlanReviewComment({
        outcome: validated.outcome,
        footer: {
          orchestratorMarker: config.orchestratorMarker,
          phase: "plan_review",
          runId,
          model,
          promptVersion: version,
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
          decisionIdentity: review.decisionIdentity,
          reviewedPlanGenerationId: validated.outcome.reviewedPlanGenerationId,
          reviewedPlanArtifactHash: validated.outcome.reviewedPlanArtifactHash,
          planReviewCycle:
            applied.state?.cycleCounters.plan_review_cycles ??
            state.cycleCounters.plan_review_cycles ??
            0,
          planReviewCycleLimit: freeze.cycleLimit,
        },
      });
      const { findPlanReviewCommentByDecision } = await import(
        "../../linear/plan-review-comment.js"
      );
      const existingDecisionComment = findPlanReviewCommentByDecision(
        comments,
        config.orchestratorMarker,
        review.decisionIdentity,
      );
      if (!existingDecisionComment) {
        await postIssueComment(client, issue.id, commentBody);
      } else {
        await events.log("idempotency_skip", "info", {
          reason: "duplicate_plan_review_decision_comment",
          decisionIdentity: review.decisionIdentity,
        });
      }
      await transitionIssueStatus(client, issue, applied.statusName);
      linearStatusAfter = applied.statusName;

      const decisionType = applied.result?.decisionType ?? review.decision;
      captureWorkflowAnalyticsEvent(
        "p_dev_workflow_transition",
        buildWorkflowAnalyticsProperties({
          workflow_schema_version: readiness.workflowSchemaVersion,
          workflow_phase_id: "plan_review",
          status_after: applied.statusName,
          transition_reason: applied.result?.reason,
          optional_phase_enabled: true,
          decision_type: decisionType,
          cycle_name: "plan_review_cycles",
          cycle_count:
            applied.state?.cycleCounters.plan_review_cycles ?? 0,
          cycle_limit: freeze.cycleLimit,
          workflow_state_revision: applied.stateRevision ?? undefined,
        }),
      );
      if (review.decision === "needs_revision" && applied.result?.reason === "review_needs_revision") {
        captureWorkflowAnalyticsEvent(
          "p_dev_review_cycle_incremented",
          buildWorkflowAnalyticsProperties({
            workflow_schema_version: readiness.workflowSchemaVersion,
            workflow_phase_id: "plan_review",
            cycle_name: "plan_review_cycles",
            cycle_count:
              applied.state?.cycleCounters.plan_review_cycles ?? 0,
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
            workflow_phase_id: "plan_review",
            cycle_name: "plan_review_cycles",
            cycle_count:
              applied.state?.cycleCounters.plan_review_cycles ?? 0,
            cycle_limit: freeze.cycleLimit,
            decision_type: "escalation",
          }),
        );
      }

      const endMeta = {
        modelId: observed.model?.id ?? model,
        modelRole: "plan_reviewer",
        promptName: promptNameForPhase("plan_review"),
        agentRole: "plan_reviewer",
        decision: review.decision,
        reviewedPlanGenerationId: latestPlan.planGenerationId,
        reviewedPlanArtifactHash: latestPlan.planArtifactHash,
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
    } finally {
      await disposeAgent(agent);
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    if (error instanceof PlanReviewError) {
      errorClassification = error.classification;
    } else {
      errorClassification = classifyUnexpectedPhaseError(error);
    }
    await events.log("phase_error", "error", {
      message,
      errorClassification,
    });
    try {
      await postErrorComment(
        client,
        issue.id,
        message,
        {
          orchestratorMarker: config.orchestratorMarker,
          phase: "plan_review",
          runId,
          model,
          promptVersion: promptVersion ?? "plan-review@2",
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
        },
        "plan_review",
        { errorClassification: errorClassification ?? undefined },
      );
    } catch {
      // best-effort
    }
    // Infrastructure failure: remain in Plan Review (no status advance, no cycle bump).
    finalOutcome = "failed";
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
    phase: "plan_review",
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
    exitCode: finalOutcome === "success" ? 0 : 1,
  };
}
