/**
 * Code Revision phase — targeted correction agent after Code Review needs_revision.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_REVISION_TIMEOUT_SECONDS,
  MILESTONE,
} from "../../config/defaults.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getCodeRevisionPromptPath,
  getCodeRevisionResultPath,
  getIssueSnapshotAfterPath,
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
import { formatCodeRevisionComment } from "../../linear/code-revision-comment.js";
import {
  createCodeRevisionAgent,
  disposeAgent,
  sendAndObserve,
} from "../../agents/production.js";
import { buildPhaseLaunchContext } from "../provenance-launch-context.js";
import { manifestModelEvidence } from "../../cursor/model.js";
import { buildCodeRevisionPrompt } from "../../prompts/builder.js";
import { CodeRevisionError } from "../errors.js";
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
import {
  createImplementationArtifactIdentity,
  hashDiffIdentity,
} from "../../workflow/implementation-artifact.js";
import { extractCodeRevisionOutcomeFromText } from "../../workflow/review-contracts.js";
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

export interface CodeRevisionPhaseOptions {
  issueKey: string;
  configPath: string;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export interface CodeRevisionPhaseResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new CodeRevisionError(
      name === "LINEAR_API_KEY"
        ? "linear_auth_failure"
        : name === "GITHUB_TOKEN"
          ? "github_auth_failure"
          : "cursor_api_failure",
      `${name} is required for live code revision runs`,
    );
  }
  return value;
}

export async function executeCodeRevisionPhase(
  options: CodeRevisionPhaseOptions,
): Promise<CodeRevisionPhaseResult> {
  const startedAt = new Date();
  const runId = `code-revision-${startedAt.getTime()}`;
  const deliveryId = process.env.GITHUB_RUN_ID ?? runId;
  const runGeneration = resolveRunGeneration();
  let { config } = await loadHarnessConfig({ configPath: options.configPath });
  const logDirectory = config.logDirectory ?? "runs";
  const runDirectory = getRunDirectory(logDirectory, options.issueKey, runId);
  await mkdir(runDirectory, { recursive: true });
  const events = new EventLogger(runDirectory);
  await events.init();
  await events.log("run_started", "info", { phase: "code_revision", runId });

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

  const reviserModel = manifestModelEvidence(config, "codeReviser");
  const model = reviserModel.model;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = "cursor_run_failed";
  let linearStatusAfter: string | null = issue.status;
  let phaseTrace: PhaseTraceHandle | null = null;
  let reviserObs: NestedObservationHandle | null = null;
  let promptVersion: string | null = null;
  let cursorAgentId: string | null = null;
  let cursorRunId: string | null = null;
  let branch: string | null = null;
  let prUrl: string | null = null;
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
    throw new CodeRevisionError(
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
    currentPhaseId: "code_revision",
  });

  const reviewerModel = manifestModelEvidence(config, "codeReviewer");
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
    throw new CodeRevisionError(
      "wrong_status",
      "Frozen phase execution has Code Review configuredReady=false",
    );
  }

  const markerTargetRepo = normalizeRepoUrl(resolved.targetRepo);
  let reviewDecision = state.lastAcceptedReviewDecision;
  if (
    !(
      reviewDecision?.phaseId === "code_review" &&
      reviewDecision.decision === "needs_revision" &&
      (reviewDecision.findings ?? []).some((f) => f.severity === "blocking")
    )
  ) {
    try {
      const comments = await listIssueComments(client, issue.id);
      const { recoverCodeReviewRevisionFromComments } = await import(
        "../../workflow/recover-code-review-decision.js"
      );
      const recovered = recoverCodeReviewRevisionFromComments({
        comments,
        orchestratorMarker: config.orchestratorMarker,
      });
      if (recovered) {
        reviewDecision = recovered;
        state = {
          ...state,
          lastAcceptedReviewDecision: recovered,
          returnDestination: state.returnDestination ?? "code_review",
        };
        await events.log("planning_comment_loaded", "info", {
          source: "code_review_decision_recovered_from_linear",
          decisionIdentity: recovered.decisionIdentity,
          blockingFindingCount: (recovered.findings ?? []).filter(
            (f) => f.severity === "blocking",
          ).length,
          reviewedPrNumber: recovered.reviewedPrNumber ?? null,
        });
      }
    } catch (error) {
      await events.log("github_pr_inspected", "warn", {
        source: "code_review_decision_recovery_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const blockingFindings =
    reviewDecision?.phaseId === "code_review" &&
    reviewDecision.decision === "needs_revision"
      ? (reviewDecision.findings ?? []).filter((f) => f.severity === "blocking")
      : [];
  if (blockingFindings.length === 0) {
    throw new CodeRevisionError(
      "wrong_status",
      "No accepted blocking Code Review findings require revision",
    );
  }

  let latestImplementation = state.latestImplementationArtifact;
  if (!latestImplementation) {
    try {
      const comments = await listIssueComments(client, issue.id);
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
            },
          );
        }
      }
    } catch (error) {
      await events.log("github_pr_inspected", "warn", {
        source: "implementation_artifact_recovery_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!latestImplementation) {
    throw new CodeRevisionError(
      "missing_implementation_pr",
      "No durable PR/implementation artifact is available for Code Revision",
    );
  }

  prUrl = latestImplementation.prUrl;
  const parsedPr = parsePrUrl(latestImplementation.prUrl);
  if (!parsedPr) {
    throw new CodeRevisionError(
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
    branch = inspection.branch;
    liveEvidence = buildLivePrEvidence({
      inspection,
      parsed: parsedPr,
      targetRepo: markerTargetRepo,
    });
  } catch (error) {
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

  const eligibility = evaluateCodeReviewExecutionEligibility({
    latestImplementation,
    liveEvidence,
    activeRunIdentities: state.activeRunIdentities,
    completedPhaseIdentities: state.completedPhaseIdentities,
    supersededGenerationIds: state.supersededGenerationIdentities,
  });
  const eligibilityDiag = buildCodeReviewExecutionEligibilityDiagnostic({
    eligibility,
    configurationSurface: "runner",
  });
  captureWorkflowAnalyticsEvent(eligibilityDiag.event, eligibilityDiag.properties);

  if (!eligibility.executionEligible) {
    throw new CodeRevisionError(
      "validation_failed",
      `Code Revision execution is not eligible: ${eligibility.failureMessages.join(" ")}`,
    );
  }

  const currentHeadSha = liveEvidence.headSha ?? latestImplementation.headSha;
  const currentDiffHash =
    liveEvidence.diffHash ??
    hashDiffIdentity({
      prNumber: latestImplementation.prNumber,
      headSha: currentHeadSha,
      baseSha: latestImplementation.baseSha,
    });

  try {
    const { prompt: basePrompt, promptVersion: version } =
      await buildCodeRevisionPrompt({
        issue,
        parsed,
        reviewedPrNumber: latestImplementation.prNumber,
        reviewedHeadSha: latestImplementation.headSha,
        reviewedBaseSha: latestImplementation.baseSha,
        reviewedDiffHash: latestImplementation.diffHash,
        prUrl: latestImplementation.prUrl,
        targetRepository: latestImplementation.targetRepository,
        branch: branchName || `_pr-${latestImplementation.prNumber}`,
        blockingFindings: blockingFindings.map((f) => ({
          id: f.id,
          category: f.category,
          evidence: f.evidence,
          requiredChange: f.requiredChange,
          file: f.file,
          line: f.line,
        })),
        causedByReviewDecisionIdentity: reviewDecision!.decisionIdentity,
        currentHeadSha,
        currentDiffHash,
        codeReviewCycle: state.cycleCounters.code_review_cycles ?? 0,
        codeReviewCycleLimit: freeze.cycleLimit,
        approvedPlanIdentity:
          state.latestPlanArtifact?.planGenerationId ?? undefined,
      });
    promptVersion = version;
    const { assembleAgentPrompt } = await import("../../prompts/assemble.js");
    const skillInjection = await assembleAgentPrompt({
      phase: "code_revision",
      localCompiledPrompt: basePrompt,
    });
    const prompt = skillInjection.prompt;
    await mkdir(path.join(runDirectory, "prompts"), { recursive: true });
    const promptPath = getCodeRevisionPromptPath(runDirectory);
    await writeFile(promptPath, `${prompt}\n`, "utf8");

    phaseTrace = await safeStartPhaseTrace(options.evaluationRuntime, {
      phase: "code_revision",
      issueKey: issue.identifier,
      runId,
      linearTeamKey: issue.teamKey ?? null,
      metadata: {
        modelId: model,
        modelRole: "code_reviser",
        promptContractVersion: version,
        reviewedPrNumber: latestImplementation.prNumber,
        causedByReviewDecisionIdentity: reviewDecision!.decisionIdentity,
      },
    });

    const telemetryCorrelation = buildTelemetryCorrelation({
      namespace: options.evaluationRuntime?.namespace ?? "default",
      issueKey: issue.identifier,
      harnessRunId: runId,
      phase: "code_revision",
      providerTraceId: phaseTrace?.correlation.traceId,
    });
    const promptProvenance = await buildPromptProvenance({
      runDirectory,
      promptContractVersion: version,
      promptTemplatePath: "src/prompts/code-revision.md",
      renderedPromptAbsolutePath: promptPath,
    });
    const declaredSkills = skillInjection.skillsUsed.map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
    }));
    const skillProvenance = await buildSkillProvenance({
      eligible: PHASE_ELIGIBLE_SKILLS.code_revision ?? [],
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
        promptName: promptNameForPhase("code_revision"),
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

    const codeRevisionBranch =
      branchName || `pr-${latestImplementation.prNumber}`;
    const codeRevisionLaunchContext = buildPhaseLaunchContext({
      config,
      linearIssueId: issue.id,
      linearIssueKey: issue.identifier,
      phase: "code_revision",
      phaseExecutionId: runId,
      harnessRunId: runId,
      agentRole: "code_reviser",
      action: "create",
      generation: 1,
      targetRepository: resolved.targetRepo,
      startingRef: codeRevisionBranch,
      prUrl: latestImplementation.prUrl,
      prNumber: latestImplementation.prNumber,
      launchSurface: "code_revision.create",
    });
    const agent = await createCodeRevisionAgent({
      apiKey: cursorApiKey,
      config,
      targetRepo: resolved.targetRepo,
      branch: codeRevisionBranch,
      prUrl: latestImplementation.prUrl,
      launchContext: codeRevisionLaunchContext,
    });

    try {
      const timeoutMs =
        (config.revision?.timeoutSeconds ?? DEFAULT_REVISION_TIMEOUT_SECONDS) *
        1000;
      reviserObs =
        phaseTrace?.startChild(
          agentObservationDisplayName({
            issueKey: issue.identifier,
            role: "code_reviser",
          }),
          "agent",
        ) ?? null;

      const observed = await Promise.race([
        sendAndObserve(agent, prompt, runDirectory, events, {
          apiKey: cursorApiKey,
          phase: "code_revision",
          launchContext: codeRevisionLaunchContext,
          sendSurface: "code_revision.send",
          sendOrdinal: 1,
          telemetryCorrelation,
          onTelemetryEvent: onTelemetry,
          targetRepo: resolved.targetRepo,
          expectedBranch: branchName || undefined,
          expectedPrUrl: latestImplementation.prUrl,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new CodeRevisionError(
                "cursor_run_timeout",
                `Cursor code revision run exceeded ${timeoutMs / 1000}s`,
              ),
            );
          }, timeoutMs);
        }),
      ]);

      cursorAgentId = observed.agentId;
      cursorRunId = observed.runId;
      branch = observed.gitResult?.branch ?? branch;
      prUrl = observed.gitResult?.prUrl ?? prUrl;
      await mkdir(path.join(runDirectory, "outputs"), { recursive: true });
      const resultPath = getCodeRevisionResultPath(runDirectory);
      await writeFile(resultPath, `${observed.assistantText}\n`, "utf8");
      const outputRef = await buildArtifactRef({
        runDirectory,
        absolutePath: resultPath,
        artifactKind: "agent_output",
      });

      const validated = extractCodeRevisionOutcomeFromText(
        observed.assistantText,
      );
      if (!validated.ok || !validated.outcome) {
        reviserObs?.end({
          metadata: {
            modelId: observed.model?.id ?? model,
            modelRole: "code_reviser",
            schemaFailure: validated.error ?? "malformed_json",
          },
        });
        throw new CodeRevisionError(
          "validation_failed",
          `Code Revision structured outcome invalid: ${validated.error ?? "unknown"}`,
        );
      }

      if (validated.outcome.resultState !== "verified_complete") {
        throw new CodeRevisionError(
          "validation_failed",
          `Code Revision ended with ${validated.outcome.resultState}`,
        );
      }

      let postInspection;
      try {
        postInspection = await inspectPullRequest(
          github,
          parsePrUrl(prUrl ?? latestImplementation.prUrl)!,
          markerTargetRepo,
        );
      } catch {
        postInspection = null;
      }

      const revisedHeadSha =
        postInspection?.headSha ?? validated.outcome.currentHeadSha;
      const revisedBaseSha =
        postInspection?.baseSha ?? latestImplementation.baseSha;
      const revisedDiffHash = hashDiffIdentity({
        prNumber: latestImplementation.prNumber,
        headSha: revisedHeadSha,
        baseSha: revisedBaseSha,
      });

      const nextImplementationArtifact = createImplementationArtifactIdentity({
        targetRepository: latestImplementation.targetRepository,
        prNumber: latestImplementation.prNumber,
        prUrl: postInspection?.url ?? latestImplementation.prUrl,
        headSha: revisedHeadSha,
        baseSha: revisedBaseSha,
        diffHash: revisedDiffHash,
        builderRunId: runId,
        workflowStateRevision: state.stateRevision + 1,
        supersedesImplementationGenerationId:
          latestImplementation.implementationGenerationId,
        causedByReviewDecisionIdentity: reviewDecision!.decisionIdentity,
      });

      const applied = await applyPhaseTransition({
        store,
        issueKey: options.issueKey,
        config,
        expectedStateRevision: state.stateRevision,
        currentPhaseId: "code_revision",
        codeReviewEffectiveEnabled: true,
        linearStatuses,
        phaseExecutionFreeze: freeze,
        outcome: {
          kind: "success",
          phaseId: "code_revision",
          attemptIdentity: runId,
        },
        evidence: {
          linearStatusName: issue.status ?? readiness.codeRevisionStatusName,
          latestPrNumber: nextImplementationArtifact.prNumber,
          latestHeadSha: nextImplementationArtifact.headSha,
          latestBaseSha: nextImplementationArtifact.baseSha,
          latestDiffHash: nextImplementationArtifact.diffHash,
          latestImplementationGenerationId:
            nextImplementationArtifact.implementationGenerationId,
          latestImplementationWorkflowStateRevision:
            nextImplementationArtifact.workflowStateRevision,
        },
        latestImplementationArtifact: nextImplementationArtifact,
        clearActiveRunId: runId,
      });

      if (!applied.applyOk || !applied.statusName) {
        throw new CodeRevisionError(
          "linear_write_failure",
          `Code Revision transition rejected: ${applied.reason}`,
        );
      }

      const commentBody = formatCodeRevisionComment({
        outcome: {
          summary: validated.outcome.summary,
          resultState: validated.outcome.resultState,
          findingsAddressed: validated.outcome.findingsAddressed,
          filesChanged: validated.outcome.filesChanged,
          testEvidence: validated.outcome.testEvidence,
          currentHeadSha: revisedHeadSha,
          currentDiffHash: revisedDiffHash,
        },
        footer: {
          orchestratorMarker: config.orchestratorMarker,
          phase: "code_revision",
          runId,
          model,
          promptVersion: version,
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
          revisionIdentity: runId,
          causedByReviewDecisionIdentity: reviewDecision!.decisionIdentity,
          currentHeadSha: revisedHeadSha,
          currentDiffHash: revisedDiffHash,
          reviewedPrNumber: latestImplementation.prNumber,
        },
      });
      await postIssueComment(client, issue.id, commentBody);
      await transitionIssueStatus(client, issue, applied.statusName);
      linearStatusAfter = applied.statusName;

      captureWorkflowAnalyticsEvent(
        "p_dev_workflow_transition",
        buildWorkflowAnalyticsProperties({
          workflow_schema_version: readiness.workflowSchemaVersion,
          workflow_phase_id: "code_revision",
          status_after: applied.statusName,
          transition_reason: applied.result?.reason,
          optional_phase_enabled: true,
          workflow_state_revision: applied.stateRevision ?? undefined,
        }),
      );

      const endMeta = {
        modelId: observed.model?.id ?? model,
        modelRole: "code_reviser",
        promptName: promptNameForPhase("code_revision"),
        agentRole: "code_reviser",
        resultState: validated.outcome.resultState,
        agentOutputSha256: outputRef?.sha256 ?? null,
        ...agentObsMetadataFromObserved({
          ...observed,
          requestedModel: {
            id: reviserModel.model,
            params: reviserModel.modelParams ?? undefined,
            parameterEvidenceSource: reviserModel.parameterEvidenceSource,
            providerDefaultParams: reviserModel.providerDefaultParams,
            harnessDefaultParams: reviserModel.harnessDefaultParams,
          },
        }),
      };
      reviserObs?.end(endMeta);
      extraEvalMetadata = endMeta;
      finalOutcome = "success";
      errorClassification = null;
    } finally {
      await disposeAgent(agent);
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    if (error instanceof CodeRevisionError) {
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
          phase: "code_revision",
          runId,
          model,
          promptVersion: promptVersion ?? "code-revision@1",
          targetRepo: resolved.targetRepo,
          baseBranch: resolved.baseBranch,
          cursorAgentId: cursorAgentId ?? undefined,
          cursorRunId: cursorRunId ?? undefined,
          branch: branch ?? undefined,
          prUrl: prUrl ?? latestImplementation.prUrl,
        },
        "code_revision",
      );
    } catch {
      // best-effort
    }
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
    phase: "code_revision",
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
    branch,
    prUrl,
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
    exitCode: finalOutcome === "success" ? 0 : 1,
  };
}
