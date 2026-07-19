import { mkdir, writeFile } from "node:fs/promises";
import { MILESTONE } from "../config/defaults.js";
import {
  assertCloudConfigFingerprintFromEnv,
  CloudConfigStaleError,
} from "../config/assert-cloud-config-fingerprint.js";
import { loadHarnessConfig } from "../config/load-config.js";
import { resolveHarnessWorkspaceRootFromConfigSource } from "../config/workspace-root.js";
import type { HarnessConfig } from "../config/types.js";
import { EventLogger } from "../artifacts/events.js";
import { createRunId } from "../artifacts/run-id.js";
import { getRunDirectory, getErrorPath } from "../artifacts/paths.js";
import { writeIssueSnapshot } from "../artifacts/snapshot.js";
import { fetchLinearIssue } from "../linear/client.js";
import { parseIssueDescription } from "../linear/parser.js";
import { assertRepoAllowed } from "../resolver/allowed-repos.js";
import { ResolverError } from "../resolver/errors.js";
import { resolveTargetRepo } from "../resolver/target-repo.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";
import { assertBaseBranchExists } from "../github/base-branch.js";
import { GitHubClient } from "../github/client.js";
import {
  resolveProductInitializationState,
  type ResolvedProductInitialization,
} from "../product/initialization-state.js";
import { readProductMarker } from "../product/read-product-marker.js";
import { inferPhaseFromStatus } from "./phase-infer.js";
import { logExecutionEnvironmentMarker } from "./execution-environment.js";
import { loadIssueFixture } from "./fixture.js";
import {
  checkDeliveryDedup,
  recordDeliveryStart,
} from "./delivery-dedup.js";
import { resolveRunGeneration } from "./run-generation.js";
import {
  assertAuthoritativeCanonicalWorkflowGate,
  CanonicalWorkflowGateError,
  classifyCanonicalGateError,
  runAuthoritativeCanonicalWorkflowGate,
} from "../workflow/canonical-workflow-gate.js";
import type { ErrorClassification, RunPhase } from "../types/run.js";
import type { ParsedIssue } from "../types/parsed-issue.js";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { acknowledgeIssueReceived } from "../linear/run-status-comment.js";
import { createLinearClient } from "../linear/writer.js";
import { captureRuntimeProvenanceAtRunStart } from "../evaluation/runtime-provenance.js";

export interface PreflightOptions {
  issueKey: string;
  configPath: string;
  fixturePath?: string;
  linearApiKey?: string;
}

export interface PreflightContext {
  config: HarnessConfig;
  issue: LinearIssueSnapshot;
  parsed: ParsedIssue;
  resolved: ResolvedTarget;
  productInitialization: ResolvedProductInitialization;
  runId: string;
  runDirectory: string;
  events: EventLogger;
  phase: RunPhase;
  phaseInferredFromStatus: string | null;
  startedAt: Date;
}

export interface PreflightFailure {
  success: false;
  config: HarnessConfig | null;
  issue: LinearIssueSnapshot | null;
  parsed: ParsedIssue;
  resolved: ResolvedTarget | null;
  runId: string;
  runDirectory: string;
  events: EventLogger | null;
  phase: RunPhase;
  phaseInferredFromStatus: string | null;
  startedAt: Date;
  errorClassification: ErrorClassification;
  message: string;
}

export type PreflightResult =
  | { success: true; context: PreflightContext }
  | PreflightFailure;

export async function runPreflight(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const startedAt = new Date();
  const runId = createRunId(options.issueKey, startedAt);
  let config: HarnessConfig | null = null;
  let runDirectory = "";
  let events: EventLogger | null = null;
  let issue: LinearIssueSnapshot | null = null;
  let parsed: ParsedIssue = {
    task: "",
    acceptanceCriteria: [],
    outOfScope: [],
    parseErrors: [],
  };
  let resolved: ResolvedTarget | null = null;
  let phase: RunPhase = "none";
  let phaseInferredFromStatus: string | null = null;
  let workspaceRoot: string | undefined;

  try {
    try {
      assertCloudConfigFingerprintFromEnv();
    } catch (error) {
      if (error instanceof CloudConfigStaleError) {
        return {
          success: false,
          config: null,
          issue: null,
          parsed,
          resolved: null,
          runId,
          runDirectory: "",
          events: null,
          phase: "none",
          phaseInferredFromStatus: null,
          startedAt,
          errorClassification: "cloud_config_stale",
          message: error.message,
        };
      }
      throw error;
    }

    const loaded = await loadHarnessConfig({ configPath: options.configPath });
    config = loaded.config;
    workspaceRoot = resolveHarnessWorkspaceRootFromConfigSource(loaded.source);
    runDirectory = getRunDirectory(config.logDirectory, options.issueKey, runId);
    events = new EventLogger(runDirectory);
    await events.init();
    await mkdir(runDirectory, { recursive: true });
    await captureRuntimeProvenanceAtRunStart(runDirectory, {
      workspaceRoot,
    });

    const executionEnvironment = logExecutionEnvironmentMarker();

    await events.log("run_started", "info", {
      issueKey: options.issueKey,
      milestone: MILESTONE,
      executionEnvironment: executionEnvironment.kind,
      executionEnvironmentMarker: executionEnvironment.marker,
      hostname: executionEnvironment.hostname,
      codespaceName: executionEnvironment.codespaceName,
      githubRunId: executionEnvironment.githubRunId,
      githubWorkflow: executionEnvironment.githubWorkflow,
      gitBranch: executionEnvironment.gitBranch,
      gitSha: executionEnvironment.gitSha,
    });
    await events.log("config_loaded", "info", {
      configSource: loaded.source.label,
      configSourceKind: loaded.source.kind,
    });

    if (options.fixturePath) {
      issue = await loadIssueFixture(options.fixturePath, options.issueKey);
      await events.log("issue_loaded_from_fixture", "info", {
        issueKey: issue.identifier,
        fixturePath: options.fixturePath,
      });
    } else {
      const apiKey = options.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
      if (!apiKey) {
        throw new CanonicalWorkflowGateError(
          "linear_auth_failure: LINEAR_API_KEY is required for live issue fetch",
          "linear_auth_failure",
        );
      }
      issue = await fetchLinearIssue(options.issueKey, apiKey);
      await events.log("issue_fetched", "info", { issueKey: issue.identifier });

      const deliveryId = process.env.LINEAR_DELIVERY_ID?.trim();
      if (deliveryId) {
        const dedup = await checkDeliveryDedup({
          logDirectory: config.logDirectory,
          deliveryId,
          runId,
          issueKey: options.issueKey,
        });
        if (dedup.shouldSkip) {
          await events.log("idempotency_skip", "info", {
            reason: dedup.reason ?? "duplicate_delivery",
            deliveryId,
            existingRunId: dedup.existing?.runId,
          });
          throw new ResolverError(
            "duplicate_delivery",
            dedup.reason ?? `Duplicate delivery ${deliveryId}`,
          );
        }
        await recordDeliveryStart({
          logDirectory: config.logDirectory,
          deliveryId,
          issueKey: options.issueKey,
          runId,
        });
      }

      if (!options.fixturePath) {
        try {
          const client = createLinearClient(apiKey);
          await acknowledgeIssueReceived(client, issue.id, {
            runId,
            deliveryId: deliveryId ?? null,
            generation: resolveRunGeneration(),
          });
        } catch {
          // Best-effort progress comment only.
        }
      }
    }

    await writeIssueSnapshot(runDirectory, issue);

    parsed = parseIssueDescription(issue.description ?? "");
    await events.log("issue_parsed", "info", {
      parseErrors: parsed.parseErrors,
      hasTargetRepo: Boolean(parsed.targetRepoRaw),
    });

    const inferred = inferPhaseFromStatus(issue.status, config);
    phase = inferred.phase;
    phaseInferredFromStatus = inferred.statusLabel;
    await events.log("phase_inferred", "info", { phase, status: phaseInferredFromStatus });

    if (parsed.parseErrors.length > 0) {
      throw new ResolverError("ambiguous_issue", parsed.parseErrors.join("; "));
    }

    resolved = resolveTargetRepo(
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
    assertRepoAllowed(resolved.targetRepo, config);
    let productInitialization: ResolvedProductInitialization = {
      state: "missing_marker",
      hasApprovedArchitecture: false,
    };
    if (process.env.GITHUB_TOKEN) {
      const github = new GitHubClient({ token: process.env.GITHUB_TOKEN });
      const markerRead = await readProductMarker({
        targetRepo: resolved.targetRepo,
        developmentBranch: resolved.baseBranch,
        github,
      });
      productInitialization = resolveProductInitializationState(markerRead.content);
      await events.log("product_marker_loaded", "info", {
        markerPath: markerRead.markerPath,
        developmentBranch: markerRead.developmentBranch,
        initializationState: productInitialization.state,
        hasApprovedArchitecture: productInitialization.hasApprovedArchitecture,
      });
      await assertBaseBranchExists(github, resolved.targetRepo, resolved.baseBranch);
    } else {
      await events.log("product_marker_skipped", "info", {
        reason: "GITHUB_TOKEN not configured",
      });
    }
    await events.log("repo_resolved", "info", { ...resolved });

    const gateResult = await runAuthoritativeCanonicalWorkflowGate({
      linearApiKey: options.linearApiKey,
      config,
      issue,
      fixturePath: options.fixturePath,
      workspaceRoot,
      configPath: options.configPath,
    });
    await events.log("canonical_workflow_preflight", "info", {
      valid: gateResult.ok,
      violationCount: gateResult.ok ? 0 : 1,
    });
    assertAuthoritativeCanonicalWorkflowGate(gateResult);

    return {
      success: true,
      context: {
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
      },
    };
  } catch (error) {
    let errorClassification: ErrorClassification = classifyCanonicalGateError(error);
    if (error instanceof ResolverError) {
      errorClassification = error.classification;
    } else if (error instanceof Error && error.message.startsWith("wrong_status")) {
      errorClassification = "wrong_status";
    } else if (
      error instanceof Error &&
      error.message.startsWith("base_branch_missing")
    ) {
      errorClassification = "base_branch_missing";
    } else if (
      error instanceof Error &&
      error.message.startsWith("wrong_pr_base_branch")
    ) {
      errorClassification = "wrong_pr_base_branch";
    }

    const message = error instanceof Error ? error.message : String(error);
    if (runDirectory) {
      await writeFile(
        getErrorPath(runDirectory),
        `${JSON.stringify({ message, errorClassification }, null, 2)}\n`,
        "utf8",
      ).catch(() => undefined);
    }

    return {
      success: false,
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
      errorClassification,
      message,
    };
  }
}
