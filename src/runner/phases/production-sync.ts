import { mkdir, writeFile } from "node:fs/promises";
import {
  MILESTONE,
  PRODUCTION_SYNC_PROMPT_VERSION,
} from "../../config/defaults.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import {
  getIssueSnapshotAfterPath,
} from "../../artifacts/paths.js";
import {
  buildProductionPromotionCommentBody,
  findLatestMergeMarker,
} from "../../linear/comments.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { parseIssueDescription } from "../../linear/parser.js";
import {
  createLinearClient,
  listIssueComments,
  postProductionSyncComment,
  transitionIssueStatus,
} from "../../linear/writer.js";
import { GitHubClient } from "../../github/client.js";
import { resolvePromotionProof } from "../../github/commit-reachability.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import { shouldCaptureApplicationPreview } from "../../preview/preview-capability.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { resolveHarnessWorkspaceRootFromConfigSource } from "../../config/workspace-root.js";
import { checkProductionSyncIdempotency } from "../idempotency.js";
import {
  CanonicalWorkflowGateError,
  classifyCanonicalGateError,
  runAuthoritativeCanonicalWorkflowGate,
} from "../../workflow/canonical-workflow-gate.js";
import type { RunManifest, FinalOutcome, ErrorClassification } from "../../types/run.js";
import type { LinearIssueSnapshot } from "../../linear/client.js";
import type { ResolvedTarget } from "../../resolver/target-repo.js";
import type { ParsedIssue } from "../../types/parsed-issue.js";
import { createRunId } from "../../artifacts/run-id.js";
import { getRunDirectory } from "../../artifacts/paths.js";
import { EventLogger } from "../../artifacts/events.js";
import { emptyMergeManifestFields } from "../../artifacts/manifest-fields.js";

export interface ProductionSyncIssueOptions {
  issueKey: string;
  configPath: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface ProductionSyncIssueResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
  skippedReason?: string;
  diagnosticIssueKeyCommits?: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for production sync`);
  }
  return value;
}

async function writeFinalManifest(
  manifest: RunManifest,
  runDirectory: string,
  parsed: ParsedIssue,
  resolved: ResolvedTarget | null,
  events: EventLogger | null,
): Promise<ProductionSyncIssueResult> {
  if (runDirectory) {
    await writeManifest(runDirectory, manifest);
    await writeRunSummary(runDirectory, manifest, parsed, resolved);
    await events?.log("run_finished", manifest.finalOutcome === "success" ? "info" : "error", {
      finalOutcome: manifest.finalOutcome,
      errorClassification: manifest.errorClassification,
    });
  }

  const exitCode =
    manifest.finalOutcome === "success" || manifest.finalOutcome === "duplicate"
      ? 0
      : manifest.finalOutcome === "skipped"
        ? 0
        : manifest.errorClassification === "missing_merge_metadata" ||
            manifest.errorClassification === "production_not_promoted" ||
            manifest.errorClassification === "wrong_status"
          ? 2
          : 3;

  return { manifest, runDirectory, exitCode };
}

export async function executeProductionSyncForIssue(
  options: ProductionSyncIssueOptions,
): Promise<ProductionSyncIssueResult> {
  const startedAt = new Date();
  const runId = createRunId(options.issueKey, startedAt);
  const loaded = await loadHarnessConfig({ configPath: options.configPath });
  const config = loaded.config;
  const workspaceRoot = resolveHarnessWorkspaceRootFromConfigSource(loaded.source);
  const runDirectory = getRunDirectory(
    config.logDirectory,
    options.issueKey,
    runId,
  );
  const events = new EventLogger(runDirectory);
  const model = "";

  let issue: LinearIssueSnapshot | null = null;
  let resolved: ResolvedTarget | null = null;
  let finalOutcome: FinalOutcome = "failed";
  let errorClassification: ErrorClassification = null;
  let skippedReason: string | undefined;
  let diagnosticIssueKeyCommits: string[] | undefined;

  const emptyParsed: ParsedIssue = {
    task: "",
    acceptanceCriteria: [],
    outOfScope: [],
    parseErrors: [],
  };

  try {
    const linearApiKey = requireEnv("LINEAR_API_KEY");
    const githubToken = requireEnv("GITHUB_TOKEN");

    issue = await fetchLinearIssue(options.issueKey, linearApiKey);
    const parsed = parseIssueDescription(issue.description ?? "");
    resolved = resolveTargetRepo(
      parsed,
      {
        projectName: issue.projectName ?? undefined,
        teamName: issue.teamName ?? undefined,
      },
      config,
    );

    if (!shouldCaptureApplicationPreview(resolved.previewProvider)) {
      await events.log("application_preview_not_configured", "info", {
        previewProvider: resolved.previewProvider,
        phase: "production_sync",
      });
    }

    const gateResult = await runAuthoritativeCanonicalWorkflowGate({
      linearApiKey,
      config,
      issue,
      workspaceRoot,
      configPath: options.configPath,
    });
    if (!gateResult.ok) {
      throw new CanonicalWorkflowGateError(
        gateResult.message,
        gateResult.errorClassification,
      );
    }

    if (resolved.baseBranch === resolved.productionBranch) {
      finalOutcome = "skipped";
      skippedReason = "base_branch_equals_production_branch";
      errorClassification = null;
    } else {
      const integrationSuccessStatus =
        resolved.integrationSuccessStatus ?? "Merged to Dev";
      const productionSuccessStatus =
        resolved.productionSuccessStatus ?? "Merged / Deployed";

      const client = createLinearClient(linearApiKey);
      const github = new GitHubClient({ token: githubToken });
      const comments = await listIssueComments(client, issue.id);
      const mergeMarker = findLatestMergeMarker(
        comments,
        config.orchestratorMarker,
      );

      if (!mergeMarker) {
        finalOutcome = "skipped";
        errorClassification = "missing_merge_metadata";
        skippedReason = "missing_merge_metadata";
      } else {
        const markers = mergeMarker.markers;
        const mergeCommitSha = markers.mergeCommitSha ?? null;
        const prUrl = markers.prUrl ?? null;
        const prNumber = markers.prNumber
          ? Number.parseInt(markers.prNumber, 10)
          : null;

        const idempotency = checkProductionSyncIdempotency(
          config,
          issue,
          comments,
          mergeCommitSha,
          productionSuccessStatus,
          integrationSuccessStatus,
        );

        if (idempotency.skip) {
          finalOutcome = "duplicate";
          errorClassification = "duplicate_phase_completed";
          skippedReason = idempotency.reason;
        } else if (!mergeCommitSha && !prUrl) {
          finalOutcome = "skipped";
          errorClassification = "missing_merge_metadata";
          skippedReason = "missing_merge_metadata";
        } else {
          const proof = await resolvePromotionProof({
            client: github,
            targetRepo: markers.targetRepo ?? resolved.targetRepo,
            productionBranch: resolved.productionBranch,
            baseBranch: resolved.baseBranch,
            mergeCommitSha,
            prUrl,
            prNumber,
            issueKey: options.issueKey,
          });

          if (!proof.proof) {
            finalOutcome = "skipped";
            errorClassification = "production_not_promoted";
            skippedReason = proof.reason;
            diagnosticIssueKeyCommits = proof.diagnosticIssueKeyCommits;
          } else if (options.dryRun) {
            finalOutcome = "success";
            skippedReason = "dry_run";
          } else {
            const productionUrl = resolved.productionUrl ?? null;

            const promotionBody = buildProductionPromotionCommentBody({
              prUrl: prUrl ?? markers.prUrl ?? "",
              branch: markers.branch ?? "unknown",
              targetRepo: markers.targetRepo ?? resolved.targetRepo,
              baseBranch: resolved.baseBranch,
              productionBranch: resolved.productionBranch,
              mergeCommitSha: proof.mergeCommitSha,
              productionHeadSha: proof.productionHeadSha,
              productionUrl,
              harnessRunId: runId,
              previousMergeRunId: markers.runId ?? null,
              promotionProofMethod: proof.method,
            });

            const footer = {
              orchestratorMarker: config.orchestratorMarker,
              phase: "production_sync",
              runId,
              model,
              promptVersion: PRODUCTION_SYNC_PROMPT_VERSION,
              targetRepo: markers.targetRepo ?? resolved.targetRepo,
              issueKey: options.issueKey,
              baseBranch: resolved.baseBranch,
              productionBranch: resolved.productionBranch,
              branch: markers.branch,
              prUrl: prUrl ?? undefined,
              prNumber: markers.prNumber,
              mergeCommitSha: proof.mergeCommitSha,
              productionHeadSha: proof.productionHeadSha,
              previousMergeRunId: markers.runId,
              promotionProofMethod: proof.method,
              deploymentUrl: productionUrl ?? undefined,
            };

            await postProductionSyncComment(
              client,
              issue.id,
              promotionBody,
              footer,
            );
            await transitionIssueStatus(client, issue, productionSuccessStatus);

            const afterIssue = await fetchLinearIssue(
              options.issueKey,
              linearApiKey,
            );
            await mkdir(`${runDirectory}/linear`, { recursive: true });
            await writeFile(
              getIssueSnapshotAfterPath(runDirectory),
              `${JSON.stringify(afterIssue, null, 2)}\n`,
              "utf8",
            );

            finalOutcome = "success";
          }
        }
      }
    }
  } catch (error) {
    finalOutcome = "failed";
    errorClassification =
      classifyCanonicalGateError(error) ??
      (error instanceof Error && error.message.includes("GITHUB_TOKEN")
        ? "github_auth_failure"
        : "github_api_failure");
    skippedReason = error instanceof Error ? error.message : String(error);
  }

  const manifest: RunManifest = {
    runId,
    issueKey: options.issueKey,
    phase: "production_sync",
    phaseInferredFromStatus: null,
    linearStatusBefore: issue?.status ?? null,
    linearStatusAfter: issue?.status ?? null,
    targetRepo: resolved?.targetRepo ?? null,
    baseBranch: resolved?.baseBranch ?? null,
    resolutionSource: resolved?.resolutionSource ?? null,
    dryRun: Boolean(options.dryRun),
    finalOutcome,
    errorClassification,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    milestone: MILESTONE,
    promptVersion: PRODUCTION_SYNC_PROMPT_VERSION,
    cursorAgentId: null,
    cursorRunId: null,
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary: skippedReason ?? null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
  };

  const result = await writeFinalManifest(
    manifest,
    runDirectory,
    emptyParsed,
    resolved,
    events,
  );
  return { ...result, skippedReason, diagnosticIssueKeyCommits };
}
