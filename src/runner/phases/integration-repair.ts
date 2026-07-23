import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { LinearClient } from "@linear/sdk";
import {
  DEFAULT_MERGE_CHECK_POLL_TIMEOUT_SECONDS,
  DEFAULT_MERGE_DEPLOYMENT_POLL_INTERVAL_SECONDS,
  INTEGRATION_REPAIR_PROMPT_VERSION,
} from "../../config/defaults.js";
import type { HarnessConfig } from "../../config/types.js";
import type { EventLogger } from "../../artifacts/events.js";
import {
  acquireBuilderAgent,
  disposeAgent,
  sendAndObserve,
} from "../../agents/production.js";
import { buildPhaseLaunchContext } from "../provenance-launch-context.js";
import type { LinearHarnessLaunchContext } from "../../provenance/launch-context.js";
import { evaluateChecksForMerge } from "../../github/check-policy.js";
import type { GitHubClient } from "../../github/client.js";
import { GitHubApiError } from "../../github/client.js";
import {
  assertHeadBranchWritePermission,
  assertPrBaseBranchMatches,
} from "../../github/base-branch.js";
import {
  inspectPullRequestForMerge,
  pollPullRequestMergeability,
  type PrInspectionResult,
} from "../../github/pr-inspector.js";
import type { ParsedPrUrl } from "../../github/pr-url.js";
import { formatHarnessCommentFooter } from "../../linear/comments.js";
import type { LinearIssueSnapshot } from "../../linear/client.js";
import { postIssueComment } from "../../linear/writer.js";
import { inferVercelReadyFromComments } from "../../preview/production-from-merge.js";
import { buildIntegrationRepairPrompt } from "../../prompts/integration-repair-builder.js";
import { buildTelemetryCorrelation } from "../../evaluation/telemetry/correlation.js";
import {
  buildPromptProvenance,
  buildSkillProvenance,
  PHASE_ELIGIBLE_SKILLS,
} from "../../evaluation/telemetry/provenance.js";
import {
  emitPromptProvenanceEvent,
  emitSkillProvenanceEvent,
} from "../../evaluation/telemetry/phase-emit.js";
import type { ResolvedTarget } from "../../resolver/target-repo.js";
import type { ParsedIssue } from "../../types/parsed-issue.js";
import { manifestModelEvidence, resolveBuilderModel } from "../../cursor/model.js";
import { listIssueComments } from "../../linear/writer.js";
import { buildIntegrationRepairIdempotencyKey } from "../builder-thread-idempotency.js";
import { BuilderThreadLineageError } from "../builder-thread-lineage.js";
import {
  builderMarkerEvidenceFromResolution,
} from "../builder-thread-evidence.js";
import { MergeError } from "../errors.js";

const DETERMINISTIC_UPDATE_ATTEMPTS = 2;
const AGENT_REPAIR_ATTEMPTS = 1;

export interface IntegrationRepairAgentEvidence {
  model: string;
  modelRole: "builder";
  modelParams: Array<{ id: string; value: string }> | null;
  cursorAgentId: string;
  cursorRunId: string;
  builderAgentId: string;
  builderThreadAction: "created" | "resumed" | "replaced";
  builderThreadGeneration: number;
  builderOriginRunId: string;
  previousBuilderAgentId?: string | null;
  builderThreadReplacementReason?: string | null;
  cursorRequestId?: string | null;
}

export interface IntegrationRepairResult {
  inspection: PrInspectionResult;
  validationSummary: string | null;
  agentEvidence?: IntegrationRepairAgentEvidence;
  integrationRepairAttempted: boolean;
  integrationRepairMode: "github_update_branch" | "cursor_agent" | "none";
  integrationRepairOutcome: "success" | "failed" | "skipped" | "not_attempted";
}

export interface IntegrationRepairOptions {
  github: GitHubClient;
  linearClient: LinearClient;
  issue: LinearIssueSnapshot;
  config: HarnessConfig;
  parsedIssue: ParsedIssue;
  resolved: ResolvedTarget;
  parsedPr: ParsedPrUrl;
  markerTargetRepo: string;
  runId: string;
  runDirectory: string;
  events: EventLogger;
  model: string;
  initialInspection: PrInspectionResult;
  cursorApiKey?: string;
}

interface RepairReportTouchedFile {
  path: string;
  category: "conflict" | "dependency_closure";
  reason: string;
}

interface RepairReport {
  status: "success" | "failed" | "ambiguous" | "requires_product_judgment";
  merge_commit_sha?: string;
  validation_summary?: string;
  touched_files?: RepairReportTouchedFile[];
}

function withRepairEvidence(
  result: Pick<
    IntegrationRepairResult,
    "inspection" | "validationSummary" | "agentEvidence"
  >,
  mode: IntegrationRepairResult["integrationRepairMode"],
  outcome: IntegrationRepairResult["integrationRepairOutcome"],
): IntegrationRepairResult {
  return {
    ...result,
    integrationRepairAttempted: mode !== "none",
    integrationRepairMode: mode,
    integrationRepairOutcome: outcome,
  };
}

function repairTriggerReason(inspection: PrInspectionResult): "behind" | "dirty" {
  const state = inspection.mergeableState?.toLowerCase();
  return state === "behind" ? "behind" : "dirty";
}

function joinMarkerList(paths: string[]): string | undefined {
  return paths.length > 0 ? paths.join(",") : undefined;
}

async function postRepairComment(
  options: IntegrationRepairOptions,
  input: {
    phase:
      | "repair_start"
      | "repair_deterministic"
      | "repair_agent_start"
      | "repair_complete"
      | "repair_failed";
    title: string;
    body: string;
    repairCycleId: string;
    repairAttempt: number;
    repairPath: "deterministic" | "agent";
    triggerReason: "behind" | "dirty" | "merge_api_conflict";
    conflictFiles: string[];
    dependencyClosureFiles?: string[];
    touchedFiles?: string[];
    mergeCommitSha?: string;
    cursorAgentId?: string;
    cursorRunId?: string;
    builderAgentId?: string;
    builderThreadGeneration?: number;
    builderThreadAction?: string;
    builderOriginRunId?: string;
    builderThreadIdempotencyKey?: string;
    previousBuilderAgentId?: string;
    builderThreadReplacementReason?: string;
  },
): Promise<void> {
  const footer = formatHarnessCommentFooter({
    orchestratorMarker: options.config.orchestratorMarker,
    phase: input.phase,
    runId: options.runId,
    model: options.model,
    promptVersion: INTEGRATION_REPAIR_PROMPT_VERSION,
    targetRepo: options.resolved.targetRepo,
    baseBranch: options.resolved.baseBranch,
    branch: options.initialInspection.branch,
    prUrl: options.initialInspection.url,
    repairAttempt: String(input.repairAttempt),
    repairPath: input.repairPath,
    triggerReason: input.triggerReason,
    conflictFiles: joinMarkerList(input.conflictFiles),
    dependencyClosureFiles: joinMarkerList(input.dependencyClosureFiles ?? []),
    touchedFiles: joinMarkerList(input.touchedFiles ?? []),
    mergeCommitSha: input.mergeCommitSha,
    repairCycleId: input.repairCycleId,
    cursorAgentId: input.cursorAgentId,
    cursorRunId: input.cursorRunId,
    builderAgentId: input.builderAgentId,
    builderThreadGeneration: input.builderThreadGeneration,
    builderThreadAction: input.builderThreadAction,
    builderOriginRunId: input.builderOriginRunId,
    builderThreadIdempotencyKey: input.builderThreadIdempotencyKey,
    previousBuilderAgentId: input.previousBuilderAgentId,
    builderThreadReplacementReason: input.builderThreadReplacementReason,
  });
  await postIssueComment(
    options.linearClient,
    options.issue.id,
    `## ${input.title}\n\n${input.body}\n\n${footer}`,
  );
  await options.events.log("linear_comment_posted", "info", {
    phase: input.phase,
  });
}

async function waitForRepairChecks(
  options: IntegrationRepairOptions,
  inspection: PrInspectionResult,
): Promise<IntegrationRepairResult> {
  const checkPollTimeout =
    options.config.merge?.checkPollTimeoutSeconds ??
    DEFAULT_MERGE_CHECK_POLL_TIMEOUT_SECONDS;
  const checkPollInterval =
    options.config.merge?.deploymentPollIntervalSeconds ??
    DEFAULT_MERGE_DEPLOYMENT_POLL_INTERVAL_SECONDS;
  const pollDeadline = Date.now() + checkPollTimeout * 1000;
  let latest = inspection;
  let checkPolicy = evaluateChecksForMerge(latest.checks, options.config);

  while (
    checkPolicy.decision === "block" &&
    checkPolicy.classification === "checks_pending" &&
    Date.now() < pollDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, checkPollInterval * 1000));
    latest = await inspectPullRequestForMerge(
      options.github,
      options.parsedPr,
      options.markerTargetRepo,
    );
    checkPolicy = evaluateChecksForMerge(latest.checks, options.config);
  }

  if (
    checkPolicy.decision === "block" &&
    (checkPolicy.classification === "checks_pending" ||
      checkPolicy.classification === "checks_unknown") &&
    inferVercelReadyFromComments(latest.comments)
  ) {
      return withRepairEvidence(
        {
          inspection: latest,
          validationSummary:
            "GitHub checks inconclusive; proceeding because Vercel deployment comment reports Ready",
        },
        "github_update_branch",
        "success",
      );
  }

  if (checkPolicy.decision === "block") {
    throw new MergeError(
      checkPolicy.classification ?? "checks_failing",
      checkPolicy.reason,
    );
  }

  return withRepairEvidence(
    {
      inspection: latest,
      validationSummary:
        checkPolicy.warnings.length > 0 ? checkPolicy.warnings.join("; ") : null,
    },
    "github_update_branch",
    "success",
  );
}

function extractJsonReport(text: string): RepairReport {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] ?? text.trim();
  try {
    return JSON.parse(raw) as RepairReport;
  } catch {
    throw new MergeError(
      "repair_scope_violation",
      "Integration repair agent did not return the required JSON repair report",
    );
  }
}

function validateRepairReport(report: RepairReport, conflictFiles: string[]): {
  touchedFiles: string[];
  dependencyClosureFiles: string[];
} {
  if (report.status === "ambiguous") {
    throw new MergeError(
      "repair_ambiguous",
      "Integration repair agent reported semantically ambiguous conflicts",
    );
  }
  if (report.status === "requires_product_judgment") {
    throw new MergeError(
      "repair_requires_product_judgment",
      "Integration repair requires product judgment beyond conflict resolution",
    );
  }
  if (report.status !== "success") {
    throw new MergeError(
      "repair_validation_failed",
      report.validation_summary ?? "Integration repair agent did not complete successfully",
    );
  }

  const touched = report.touched_files ?? [];
  if (touched.length === 0) {
    throw new MergeError(
      "repair_scope_violation",
      "Integration repair agent did not report touched files",
    );
  }

  const conflictSet = new Set(conflictFiles);
  const dependencyClosureFiles: string[] = [];
  for (const file of touched) {
    if (!file.path || !file.reason) {
      throw new MergeError(
        "repair_scope_violation",
        "Integration repair agent touched file report is missing path or reason",
      );
    }
    if (file.category === "conflict") {
      if (!conflictSet.has(file.path)) {
        throw new MergeError(
          "repair_scope_violation",
          `Integration repair agent marked non-conflict file as conflict: ${file.path}`,
        );
      }
    } else if (file.category === "dependency_closure") {
      dependencyClosureFiles.push(file.path);
    } else {
      throw new MergeError(
        "repair_scope_violation",
        `Integration repair agent reported unsupported file category for ${file.path}`,
      );
    }
  }

  return {
    touchedFiles: touched.map((file) => file.path),
    dependencyClosureFiles,
  };
}

async function attemptDeterministicRepair(
  options: IntegrationRepairOptions,
  repairCycleId: string,
  conflictFiles: string[],
): Promise<IntegrationRepairResult | null> {
  let inspection = options.initialInspection;
  const triggerReason = repairTriggerReason(inspection);
  for (let attempt = 1; attempt <= DETERMINISTIC_UPDATE_ATTEMPTS; attempt += 1) {
    await options.events.log("repair_deterministic_update_attempted", "info", {
      attempt,
      prUrl: inspection.url,
      headSha: inspection.headSha,
    });
    try {
      await options.github.updatePullRequestBranch(
        options.parsedPr.owner,
        options.parsedPr.repo,
        options.parsedPr.pullNumber,
        { expectedHeadSha: inspection.headSha },
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 403) {
        throw new MergeError(
          "repair_head_branch_write_denied",
          "HARNESS_GITHUB_TOKEN cannot update the PR branch. Grant classic repo scope, or fine-grained Contents: Read and write plus Pull requests: Read and write on the target repo.",
        );
      }
      if (error instanceof GitHubApiError && error.status === 422) {
        await postRepairComment(options, {
          phase: "repair_deterministic",
          title: "Deterministic integration repair could not update branch",
          body: `GitHub update-branch returned 422 on attempt ${attempt}. Escalating to agent repair if attempts remain.`,
          repairCycleId,
          repairAttempt: attempt,
          repairPath: "deterministic",
          triggerReason,
          conflictFiles,
        });
        return null;
      }
      throw error;
    }

    inspection = await pollPullRequestMergeability(
      options.github,
      options.parsedPr,
      options.markerTargetRepo,
      {
        timeoutSeconds:
          options.config.merge?.checkPollTimeoutSeconds ??
          DEFAULT_MERGE_CHECK_POLL_TIMEOUT_SECONDS,
        intervalSeconds:
          options.config.merge?.deploymentPollIntervalSeconds ??
          DEFAULT_MERGE_DEPLOYMENT_POLL_INTERVAL_SECONDS,
      },
    );

    await postRepairComment(options, {
      phase: "repair_deterministic",
      title: "Deterministic integration repair attempted",
      body: `GitHub update-branch accepted attempt ${attempt}. Current mergeable_state: \`${inspection.mergeableState ?? "unknown"}\`.`,
      repairCycleId,
      repairAttempt: attempt,
      repairPath: "deterministic",
      triggerReason,
      conflictFiles,
    });

    const state = inspection.mergeableState?.toLowerCase();
    if (inspection.mergeable === true && state === "clean") {
      return waitForRepairChecks(options, inspection);
    }
    if (state === "dirty") {
      return null;
    }
  }

  throw new MergeError(
    "github_merge_failure",
    `PR remained ${inspection.mergeableState ?? "not mergeable"} after deterministic repair attempts`,
  );
}

async function attemptAgentRepair(
  options: IntegrationRepairOptions,
  repairCycleId: string,
  conflictFiles: string[],
): Promise<IntegrationRepairResult> {
  if (!options.cursorApiKey) {
    throw new MergeError(
      "cursor_api_failure",
      "CURSOR_API_KEY is required for agent integration repair",
    );
  }

  const baseRef = await options.github.getBranchRef(
    options.parsedPr.owner,
    options.parsedPr.repo,
    options.resolved.baseBranch,
  );
  const repoConfig = options.config.repos.find(
    (repo) => repo.id === options.resolved.repoConfigId,
  );
  const validationCommands = repoConfig?.validation?.commands ?? [];
  const { prompt: basePrompt } = await buildIntegrationRepairPrompt({
    issue: options.issue,
    parsed: options.parsedIssue,
    resolved: options.resolved,
    branch: options.initialInspection.branch,
    prUrl: options.initialInspection.url,
    baseHeadSha: baseRef.object.sha,
    conflictFiles,
    changedFiles: options.initialInspection.changedFiles.map((file) => file.path),
    baseBranchDelta: [],
    validationCommands,
  });
  const { assembleAgentPrompt } = await import("../../prompts/assemble.js");
  const { promptNameForPhase } = await import("../../prompts/skill-inject.js");
  const skillInjection = await assembleAgentPrompt({
    phase: "integration_repair",
    localCompiledPrompt: basePrompt,
  });
  const prompt = skillInjection.prompt;

  await mkdir(`${options.runDirectory}/prompts`, { recursive: true });
  const repairPromptPath = `${options.runDirectory}/prompts/integration-repair-agent.md`;
  await writeFile(repairPromptPath, `${prompt}\n`, "utf8");
  const telemetryCorrelation = buildTelemetryCorrelation({
    namespace: "default",
    issueKey: options.issue.identifier,
    harnessRunId: options.runId,
    phase: "integration_repair",
  });
  const promptProvenance = await buildPromptProvenance({
    runDirectory: options.runDirectory,
    promptContractVersion: INTEGRATION_REPAIR_PROMPT_VERSION,
    promptTemplatePath: "src/prompts/integration-repair.md",
    renderedPromptAbsolutePath: repairPromptPath,
  });
  const declaredSkills = skillInjection.skillsUsed.map((s) => ({
    skillId: s.skillId,
    sourcePath: s.sourcePath,
    role: s.role,
  }));
  const skillProvenance = await buildSkillProvenance({
    eligible: PHASE_ELIGIBLE_SKILLS.integration_repair ?? [],
    declared: declaredSkills,
    observed: declaredSkills,
  });
  await emitPromptProvenanceEvent(
    options.runDirectory,
    telemetryCorrelation,
    {
      ...promptProvenance,
      promptName: promptNameForPhase("integration_repair"),
      promptAssemblySchemaVersion: 1,
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
  );
  await emitSkillProvenanceEvent(
    options.runDirectory,
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
  );

  let inspectionBeforeAgent = await inspectPullRequestForMerge(
    options.github,
    options.parsedPr,
    options.markerTargetRepo,
  );
  const comments = await listIssueComments(options.linearClient, options.issue.id);
  const repairIdempotencyKey = buildIntegrationRepairIdempotencyKey({
    issueKey: options.issue.identifier,
    prUrl: inspectionBeforeAgent.url,
    repairCycleId,
    baseHeadSha: baseRef.object.sha,
    headSha: inspectionBeforeAgent.headSha,
  });
  const acquired = await acquireBuilderAgent({
    apiKey: options.cursorApiKey,
    config: options.config,
    phase: "integration_repair",
    events: options.events,
    context: {
      issueKey: options.issue.identifier,
      harnessRunId: options.runId,
      targetRepo: options.markerTargetRepo,
      baseBranch: options.resolved.baseBranch,
      branch: inspectionBeforeAgent.branch,
      prUrl: inspectionBeforeAgent.url,
      idempotencyKey: repairIdempotencyKey,
      comments,
      orchestratorMarker: options.config.orchestratorMarker,
    },
    buildLaunchContext: (info) =>
      buildPhaseLaunchContext({
        config: options.config,
        linearIssueId: options.issue.id,
        linearIssueKey: options.issue.identifier,
        phase: "integration_repair",
        phaseExecutionId: options.runId,
        harnessRunId: options.runId,
        agentRole: "builder",
        action: info.action,
        generation: info.generation,
        priorAgentId: info.priorAgentId,
        targetRepository: options.markerTargetRepo,
        startingRef: inspectionBeforeAgent.branch,
        prUrl: inspectionBeforeAgent.url,
        launchSurface: info.launchSurface,
      }),
  });
  const builderEvidence = builderMarkerEvidenceFromResolution(
    acquired.continuity,
    repairIdempotencyKey,
  );
  const agent = acquired.agent;
  const repairAction =
    acquired.continuity.action === "resumed"
      ? ("resume" as const)
      : ("replacement" as const);
  const repairLaunchContext: LinearHarnessLaunchContext =
    buildPhaseLaunchContext({
      config: options.config,
      linearIssueId: options.issue.id,
      linearIssueKey: options.issue.identifier,
      phase: "integration_repair",
      phaseExecutionId: options.runId,
      harnessRunId: options.runId,
      agentRole: "builder",
      action: repairAction,
      generation: acquired.continuity.reference.generation,
      priorAgentId: acquired.continuity.previousAgentId,
      targetRepository: options.markerTargetRepo,
      startingRef: inspectionBeforeAgent.branch,
      prUrl: inspectionBeforeAgent.url,
      launchSurface:
        repairAction === "resume"
          ? "integration_repair.resume"
          : "integration_repair.replacement",
    });

  try {
    let observed;
    let repairAgentId: string | null = null;
    let repairRunId: string | null = null;
    let repairRequestId: string | null = null;
    const builderModelEvidence = manifestModelEvidence(options.config, "builder");
    for (let attempt = 1; attempt <= AGENT_REPAIR_ATTEMPTS; attempt += 1) {
      await options.events.log("repair_agent_started", "info", {
        attempt,
        prUrl: inspectionBeforeAgent.url,
      });
      observed = await sendAndObserve(
        agent,
        prompt,
        options.runDirectory,
        options.events,
        {
          phase: "integration_repair",
          launchContext: repairLaunchContext,
          targetRepo: options.markerTargetRepo,
          expectedBranch: inspectionBeforeAgent.branch,
          expectedPrUrl: inspectionBeforeAgent.url,
          apiKey: options.cursorApiKey,
          model: resolveBuilderModel(options.config),
          mode: "agent",
          idempotencyKey: repairIdempotencyKey,
          telemetryCorrelation,
          onBeforeSend: async ({ agentId }) => {
            repairAgentId = agentId;
            await postRepairComment(options, {
              phase: "repair_agent_start",
              title: "Integration repair agent started",
              body: `Repair agent started with Composer 2.5 to merge \`${options.resolved.baseBranch}\` into \`${inspectionBeforeAgent.branch}\` and resolve conflicts.`,
              repairCycleId,
              repairAttempt: attempt,
              repairPath: "agent",
              triggerReason: repairTriggerReason(options.initialInspection),
              conflictFiles,
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
          },
          onAgentCreated: async ({ agentId, runId: cursorRunId }) => {
            repairAgentId = agentId;
            repairRunId = cursorRunId;
            await options.events.log("builder_followup_run_started", "info", {
              agentId,
              runId: cursorRunId,
              phase: "integration_repair",
            });
          },
        },
      );
    }

    if (!observed) {
      throw new MergeError("cursor_run_failed", "Integration repair agent did not run");
    }
    repairRequestId = observed.requestId ?? null;

    const inspectionAfterAgent = await inspectPullRequestForMerge(
      options.github,
      options.parsedPr,
      options.markerTargetRepo,
    );
    if (inspectionAfterAgent.headSha === inspectionBeforeAgent.headSha) {
      throw new MergeError(
        "repair_validation_failed",
        "Integration repair agent did not push a repaired PR branch",
      );
    }

    const report = extractJsonReport(observed.assistantText);
    const scope = validateRepairReport(report, conflictFiles);

    const mergeableInspection = await pollPullRequestMergeability(
      options.github,
      options.parsedPr,
      options.markerTargetRepo,
      {
        timeoutSeconds:
          options.config.merge?.checkPollTimeoutSeconds ??
          DEFAULT_MERGE_CHECK_POLL_TIMEOUT_SECONDS,
        intervalSeconds:
          options.config.merge?.deploymentPollIntervalSeconds ??
          DEFAULT_MERGE_DEPLOYMENT_POLL_INTERVAL_SECONDS,
      },
    );
    try {
      assertPrBaseBranchMatches({
        prUrl: mergeableInspection.url,
        actualBaseBranch: mergeableInspection.baseBranch,
        expectedBaseBranch: options.resolved.baseBranch,
      });
    } catch (error) {
      throw new MergeError(
        "wrong_pr_base_branch",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      mergeableInspection.mergeable !== true ||
      mergeableInspection.mergeableState?.toLowerCase() !== "clean"
    ) {
      throw new MergeError(
        "repair_validation_failed",
        `Integration repair agent finished but PR is ${mergeableInspection.mergeableState ?? "not mergeable"}`,
      );
    }

    const checked = await waitForRepairChecks(options, mergeableInspection);
    await postRepairComment(options, {
      phase: "repair_complete",
      title: "Integration repair complete",
      body:
        report.validation_summary ??
        checked.validationSummary ??
        "Repair agent pushed the PR branch and validation passed.",
      repairCycleId,
      repairAttempt: 1,
      repairPath: "agent",
      triggerReason: repairTriggerReason(options.initialInspection),
      conflictFiles,
      dependencyClosureFiles: scope.dependencyClosureFiles,
      touchedFiles: scope.touchedFiles,
      mergeCommitSha: report.merge_commit_sha ?? inspectionAfterAgent.headSha,
      cursorAgentId: repairAgentId ?? undefined,
      cursorRunId: repairRunId ?? undefined,
      builderAgentId: builderEvidence.builderAgentId,
      builderThreadGeneration: builderEvidence.builderThreadGeneration,
      builderThreadAction: builderEvidence.builderThreadAction,
      builderOriginRunId: builderEvidence.builderOriginRunId,
      builderThreadIdempotencyKey: builderEvidence.builderThreadIdempotencyKey,
      previousBuilderAgentId: builderEvidence.previousBuilderAgentId,
      builderThreadReplacementReason: builderEvidence.builderThreadReplacementReason,
    });
    return withRepairEvidence(
      {
        inspection: checked.inspection,
        validationSummary:
          report.validation_summary ?? checked.validationSummary ?? observed.assistantText,
        ...(repairAgentId && repairRunId
          ? {
              agentEvidence: {
                model: builderModelEvidence.model,
                modelRole: "builder" as const,
                modelParams: builderModelEvidence.modelParams,
                cursorAgentId: repairAgentId,
                cursorRunId: repairRunId,
                builderAgentId: acquired.continuity.reference.agentId,
                builderThreadAction: acquired.continuity.action,
                builderThreadGeneration: acquired.continuity.reference.generation,
                builderOriginRunId: acquired.continuity.reference.originHarnessRunId,
                previousBuilderAgentId: acquired.continuity.previousAgentId ?? null,
                builderThreadReplacementReason:
                  acquired.continuity.replacementReason ?? null,
                cursorRequestId: repairRequestId,
              },
            }
          : {}),
      },
      "cursor_agent",
      "success",
    );
  } catch (error) {
    await options.events.log("repair_failed", "error", {
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof BuilderThreadLineageError) {
      throw new MergeError("builder_lineage_integrity", error.message);
    }
    throw error;
  } finally {
    await disposeAgent(agent);
  }
}

export async function attemptIntegrationRepair(
  options: IntegrationRepairOptions,
): Promise<IntegrationRepairResult> {
  const repairCycleId = randomUUID();
  const conflictFiles = options.initialInspection.changedFiles.map((file) => file.path);
  const triggerReason = repairTriggerReason(options.initialInspection);
  await options.events.log("repair_started", "info", {
    repairCycleId,
    prUrl: options.initialInspection.url,
    triggerReason,
  });

  try {
    try {
      await assertHeadBranchWritePermission(options.github, options.resolved.targetRepo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeError(
        message.includes("repair_head_branch_write_denied")
          ? "repair_head_branch_write_denied"
          : "github_auth_failure",
        message,
      );
    }

    await postRepairComment(options, {
      phase: "repair_start",
      title: "Integration repair started",
      body: `PR became \`${options.initialInspection.mergeableState ?? "not mergeable"}\` after waiting in the merge queue. The harness will try deterministic update-branch first, then agent repair if needed.`,
      repairCycleId,
      repairAttempt: 1,
      repairPath: "deterministic",
      triggerReason,
      conflictFiles,
    });

    const deterministic = await attemptDeterministicRepair(
      options,
      repairCycleId,
      conflictFiles,
    );
    if (deterministic) {
      await options.events.log("repair_completed", "info", {
        repairCycleId,
        path: "deterministic",
      });
      await options.events.log("repair_returned_to_merge", "info", {
        repairCycleId,
        prUrl: deterministic.inspection.url,
      });
      return withRepairEvidence(deterministic, "github_update_branch", "success");
    }

    const agentResult = await attemptAgentRepair(options, repairCycleId, conflictFiles);
    await options.events.log("repair_completed", "info", {
      repairCycleId,
      path: "agent",
    });
    await options.events.log("repair_returned_to_merge", "info", {
      repairCycleId,
      prUrl: agentResult.inspection.url,
    });
    return withRepairEvidence(agentResult, "cursor_agent", "success");
  } catch (error) {
    await options.events.log("repair_failed", "error", {
      repairCycleId,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await postRepairComment(options, {
        phase: "repair_failed",
        title: "Integration repair failed",
        body: error instanceof Error ? error.message : String(error),
        repairCycleId,
        repairAttempt: 1,
        repairPath: "agent",
        triggerReason,
        conflictFiles,
      });
    } catch {
      // Best-effort repair marker; merge phase will still block clearly.
    }
    throw error;
  }
}
