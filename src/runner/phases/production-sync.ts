import { mkdir, writeFile } from "node:fs/promises";
import {
  MILESTONE,
  PRODUCTION_SYNC_PROMPT_VERSION,
} from "../../config/defaults.js";
import { writeManifest } from "../../artifacts/manifest.js";
import { writeRunSummary } from "../../artifacts/summary.js";
import { getIssueSnapshotAfterPath } from "../../artifacts/paths.js";
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
import { verifyVercelProductionDeployment } from "../../preview/production-deployment-verify.js";
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
import {
  createEmptyWorkflowState,
  resolvePhaseWorkflowStateStore,
  type WorkflowStateStore,
  type WorkflowStateRecord,
} from "../../workflow/state/index.js";
import { WORKFLOW_SCHEMA_VERSION } from "../../workflow/definition/product-development.v2.js";
import type { HarnessConfig } from "../../config/types.js";
import {
  buildProductionEffectId,
  createProductionCompletionRecord,
  isProductionEffectCompleted,
  upsertProductionEffect,
  withProductionState,
  type ProductionCompletionRecord,
  type ProductionEffectKind,
} from "../../workflow/state/production-completion.js";
import { createEvaluationRuntime } from "../../evaluation/runtime.js";
import { deriveSessionId } from "../../evaluation/identifiers.js";
import {
  buildFinalProductionDeliveryOutcomeScore,
  buildProductionMilestoneScore,
  type ProductionDeliveryMilestone,
} from "../../evaluation/outcomes.js";
import {
  safeRecordScore,
  safeStartPhaseTrace,
} from "../../evaluation/phase-helpers.js";
import type { EvaluationRuntime } from "../../evaluation/types.js";
import type { PhaseTraceHandle } from "../../evaluation/types.js";

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
  productionCompletionId?: string;
  productionState?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for production sync`);
  }
  return value;
}

async function loadWorkflowStateForIssue(input: {
  issueKey: string;
  config: HarnessConfig;
  teamId?: string | null;
}): Promise<{ store: WorkflowStateStore | null; state: WorkflowStateRecord }> {
  try {
    const store = await resolvePhaseWorkflowStateStore({
      config: input.config,
      teamId: input.teamId ?? undefined,
    });
    const existing = await store.load(input.issueKey);
    if (existing) {
      return { store, state: existing };
    }
    return {
      store,
      state: createEmptyWorkflowState({
        issueKey: input.issueKey,
        workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      }),
    };
  } catch {
    return {
      store: null,
      state: createEmptyWorkflowState({
        issueKey: input.issueKey,
        workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
      }),
    };
  }
}

async function persistCompletion(
  store: WorkflowStateStore | null,
  state: WorkflowStateRecord,
  completion: ProductionCompletionRecord,
): Promise<WorkflowStateRecord> {
  const next: WorkflowStateRecord = {
    ...state,
    stateRevision: state.stateRevision + 1,
    productionCompletion: completion,
  };
  if (!store) {
    return next;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const saved = await store.compareAndSet({
      issueKey: state.issueKey,
      expectedRevision: state.stateRevision,
      next,
    });
    if (saved) {
      return saved;
    }
    const latest = await store.load(state.issueKey);
    if (!latest) {
      break;
    }
    state = latest;
    next.stateRevision = latest.stateRevision + 1;
    next.productionCompletion = completion;
  }
  return next;
}

function resolveCompletionRecord(
  state: WorkflowStateRecord,
  input: {
    issueKey: string;
    targetRepository: string;
    mergeToDevSha: string;
    productionBranch: string;
  },
): ProductionCompletionRecord {
  const existing = state.productionCompletion;
  if (
    existing &&
    existing.mergeToDevSha.toLowerCase() === input.mergeToDevSha.toLowerCase() &&
    existing.productionBranch === input.productionBranch &&
    existing.targetRepository.trim().toLowerCase() ===
      input.targetRepository.trim().toLowerCase()
  ) {
    return existing;
  }
  return createProductionCompletionRecord(input);
}

function milestoneForEffect(
  kind: ProductionEffectKind,
): ProductionDeliveryMilestone | null {
  switch (kind) {
    case "langfuse_promoted_to_main":
      return "promoted_to_main";
    case "langfuse_production_deployment_started":
      return "production_deployment_started";
    case "langfuse_production_deployment_ready":
      return "production_deployment_ready";
    case "langfuse_production_verified":
      return "production_verified";
    default:
      return null;
  }
}

function emitProductionMilestone(
  runtime: EvaluationRuntime | null,
  sessionId: string,
  completion: ProductionCompletionRecord,
  kind: ProductionEffectKind,
  timestamp: string,
  traceId?: string,
): void {
  const milestone = milestoneForEffect(kind);
  if (!runtime || !milestone) {
    return;
  }
  safeRecordScore(
    runtime,
    buildProductionMilestoneScore({
      namespace: runtime.namespace,
      sessionId,
      milestone,
      productionCompletionId: completion.productionCompletionId,
      timestamp,
      traceId,
    }),
  );
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
  let productionCompletionId: string | undefined;
  let productionState: string | undefined;
  let evaluationRuntime: EvaluationRuntime | null = null;
  let phaseTrace: PhaseTraceHandle | null = null;

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

        if (idempotency.skip && !options.force) {
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

          const { store, state: initialState } = await loadWorkflowStateForIssue({
            issueKey: options.issueKey,
            config,
            teamId: issue.teamId,
          });
          let state = initialState;

          if (!proof.proof) {
            if (proof.reason === "promotion_method_unsupported") {
              const mergeShaForIdentity =
                mergeCommitSha ?? proof.diagnosticIssueKeyCommits?.[0] ?? "unknown";
              let completion = resolveCompletionRecord(state, {
                issueKey: options.issueKey,
                targetRepository: markers.targetRepo ?? resolved.targetRepo,
                mergeToDevSha: mergeShaForIdentity,
                productionBranch: resolved.productionBranch,
              });
              completion = withProductionState(completion, "blocked", {
                blockedReason: "promotion_method_unsupported",
              });
              state = await persistCompletion(store, state, completion);
              productionCompletionId = completion.productionCompletionId;
              productionState = completion.state;
              finalOutcome = "skipped";
              errorClassification = "production_not_promoted";
              skippedReason = "promotion_method_unsupported";
              diagnosticIssueKeyCommits = proof.diagnosticIssueKeyCommits;
            } else {
              finalOutcome = "skipped";
              errorClassification = "production_not_promoted";
              skippedReason = proof.reason;
              diagnosticIssueKeyCommits = proof.diagnosticIssueKeyCommits;
            }
          } else {
            let completion = resolveCompletionRecord(state, {
              issueKey: options.issueKey,
              targetRepository: markers.targetRepo ?? resolved.targetRepo,
              mergeToDevSha: proof.mergeCommitSha,
              productionBranch: resolved.productionBranch,
            });
            productionCompletionId = completion.productionCompletionId;

            completion = withProductionState(completion, "promotion_proven", {
              firstProductionHeadContainingMerge: proof.productionHeadSha,
              promotionSha: proof.productionHeadSha,
            });

            evaluationRuntime = await createEvaluationRuntime();
            const sessionId = deriveSessionId(
              evaluationRuntime.namespace,
              options.issueKey,
            );
            const now = new Date().toISOString();
            if (!options.dryRun) {
              phaseTrace = await safeStartPhaseTrace(evaluationRuntime, {
                phase: "production_sync",
                issueKey: options.issueKey,
                runId,
                metadata: {
                  productionCompletionId: completion.productionCompletionId,
                  mergeToDevSha: proof.mergeCommitSha,
                  productionHeadSha: proof.productionHeadSha,
                },
              });
            }
            const scoreTraceId = phaseTrace?.correlation.traceId;

            if (
              !isProductionEffectCompleted(completion, "langfuse_promoted_to_main")
            ) {
              if (!options.dryRun) {
                emitProductionMilestone(
                  evaluationRuntime,
                  sessionId,
                  completion,
                  "langfuse_promoted_to_main",
                  now,
                  scoreTraceId,
                );
                completion = upsertProductionEffect(
                  completion,
                  "langfuse_promoted_to_main",
                  "completed",
                  { now },
                );
              }
            }

            const previewProvider = (
              resolved.previewProvider ?? ""
            ).trim().toLowerCase();
            const requiresVercelDeploy = previewProvider === "vercel";

            if (!requiresVercelDeploy) {
              // No deployment provider: record promotion only; do not project terminal.
              completion = withProductionState(completion, "blocked", {
                blockedReason: "deployment_provider_not_configured",
              });
              state = await persistCompletion(store, state, completion);
              productionState = completion.state;
              finalOutcome = "skipped";
              skippedReason = "deployment_provider_not_configured";
              errorClassification = null;
            } else {
              completion = withProductionState(
                completion,
                "deployment_verification_pending",
              );

              const vercelToken = process.env.VERCEL_TOKEN;
              if (!vercelToken) {
                completion = withProductionState(completion, "blocked", {
                  blockedReason: "vercel_token_missing",
                });
                state = await persistCompletion(store, state, completion);
                productionState = completion.state;
                finalOutcome = "skipped";
                skippedReason = "vercel_token_missing";
                errorClassification = "production_not_promoted";
              } else {
                if (
                  !isProductionEffectCompleted(
                    completion,
                    "langfuse_production_deployment_started",
                  ) &&
                  !options.dryRun
                ) {
                  emitProductionMilestone(
                    evaluationRuntime,
                    sessionId,
                    completion,
                    "langfuse_production_deployment_started",
                    now,
                    scoreTraceId,
                  );
                  completion = upsertProductionEffect(
                    completion,
                    "langfuse_production_deployment_started",
                    "completed",
                    { now },
                  );
                }

                const deploy = await verifyVercelProductionDeployment({
                  vercelToken,
                  githubClient: github,
                  targetRepo: markers.targetRepo ?? resolved.targetRepo,
                  productionBranch: resolved.productionBranch,
                  mergeToDevSha: proof.mergeCommitSha,
                  productionHeadSha: proof.productionHeadSha,
                });

                if (!deploy.verified) {
                  completion = withProductionState(completion, "blocked", {
                    blockedReason: deploy.reason,
                    deploymentId: deploy.deploymentId,
                    deploymentSha: deploy.deploymentSha,
                  });
                  state = await persistCompletion(store, state, completion);
                  productionState = completion.state;
                  finalOutcome = "skipped";
                  skippedReason = deploy.reason;
                  errorClassification = "production_not_promoted";
                } else {
                  if (
                    !isProductionEffectCompleted(
                      completion,
                      "langfuse_production_deployment_ready",
                    ) &&
                    !options.dryRun
                  ) {
                    emitProductionMilestone(
                      evaluationRuntime,
                      sessionId,
                      completion,
                      "langfuse_production_deployment_ready",
                      now,
                      scoreTraceId,
                    );
                    completion = upsertProductionEffect(
                      completion,
                      "langfuse_production_deployment_ready",
                      "completed",
                      { now },
                    );
                  }

                  completion = withProductionState(
                    completion,
                    "deployment_verified",
                    {
                      deploymentProvider: deploy.provider,
                      deploymentId: deploy.deploymentId,
                      deploymentSha: deploy.deploymentSha,
                      aliasSha: deploy.aliasSha,
                      productionAliasVerifiedAt: now,
                    },
                  );

                  if (options.dryRun) {
                    productionState = completion.state;
                    finalOutcome = "success";
                    skippedReason = "dry_run";
                  } else {
                    completion = withProductionState(
                      completion,
                      "linear_projection_pending",
                    );

                    const linearCommentEffect: ProductionEffectKind =
                      "linear_production_comment";
                    const linearStatusEffect: ProductionEffectKind =
                      "linear_status_transition";
                    const commentEffectId = buildProductionEffectId(
                      completion.productionCompletionId,
                      linearCommentEffect,
                    );

                    if (
                      !isProductionEffectCompleted(completion, linearCommentEffect)
                    ) {
                      const productionUrl =
                        resolved.productionUrl ?? deploy.deploymentUrl;

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
                        phase: "production_sync" as const,
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
                        deploymentUrl: productionUrl,
                        productionCompletionId: completion.productionCompletionId,
                        productionEffectId: commentEffectId,
                      };

                      await postProductionSyncComment(
                        client,
                        issue.id,
                        promotionBody,
                        footer,
                      );
                      completion = upsertProductionEffect(
                        completion,
                        linearCommentEffect,
                        "completed",
                        { now },
                      );
                    }

                    if (
                      !isProductionEffectCompleted(completion, linearStatusEffect)
                    ) {
                      await transitionIssueStatus(
                        client,
                        issue,
                        productionSuccessStatus,
                      );
                      completion = upsertProductionEffect(
                        completion,
                        linearStatusEffect,
                        "completed",
                        { now },
                      );
                    }

                    completion = withProductionState(
                      completion,
                      "langfuse_projection_pending",
                    );

                    if (
                      !isProductionEffectCompleted(
                        completion,
                        "langfuse_production_verified",
                      )
                    ) {
                      emitProductionMilestone(
                        evaluationRuntime,
                        sessionId,
                        completion,
                        "langfuse_production_verified",
                        now,
                        scoreTraceId,
                      );
                      completion = upsertProductionEffect(
                        completion,
                        "langfuse_production_verified",
                        "completed",
                        { now },
                      );
                    }

                    if (
                      !isProductionEffectCompleted(
                        completion,
                        "langfuse_delivery_outcome",
                      )
                    ) {
                      safeRecordScore(
                        evaluationRuntime,
                        buildFinalProductionDeliveryOutcomeScore({
                          namespace: evaluationRuntime.namespace,
                          sessionId,
                          productionCompletionId:
                            completion.productionCompletionId,
                          timestamp: now,
                          traceId: scoreTraceId,
                        }),
                      );
                      completion = upsertProductionEffect(
                        completion,
                        "langfuse_delivery_outcome",
                        "completed",
                        { now },
                      );
                    }

                    if (phaseTrace) {
                      phaseTrace.finish({
                        finalOutcome: "success",
                        errorClassification: null,
                        linearStatusAfter: productionSuccessStatus,
                        prCreated: false,
                        previewAvailable: Boolean(
                          resolved.productionUrl ?? deploy.deploymentUrl,
                        ),
                        changedFileCount: 0,
                      });
                      phaseTrace = null;
                    }

                    completion = withProductionState(completion, "completed");
                    state = await persistCompletion(store, state, completion);
                    productionState = completion.state;

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
  } finally {
    if (evaluationRuntime) {
      try {
        await evaluationRuntime.flushAndShutdown();
      } catch {
        // Non-authoritative: Linear/durable effects already committed.
      }
    }
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
  return {
    ...result,
    skippedReason,
    diagnosticIssueKeyCommits,
    productionCompletionId,
    productionState,
  };
}
