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
  findAdoptableProductionSyncComment,
  findLatestMergeMarker,
} from "../../linear/comments.js";
import { fetchLinearIssue } from "../../linear/client.js";
import { parseIssueDescription } from "../../linear/parser.js";
import {
  createLinearClient,
  listIssueComments,
  postProductionSyncComment,
  transitionIssueStatus,
  type LinearCommentRecord,
} from "../../linear/writer.js";
import { GitHubClient } from "../../github/client.js";
import { resolvePromotionProof } from "../../github/commit-reachability.js";
import { resolveTargetRepo } from "../../resolver/target-repo.js";
import { shouldCaptureApplicationPreview } from "../../preview/preview-capability.js";
import { verifyVercelProductionDeployment } from "../../preview/production-deployment-verify.js";
import { requiresVercelProductionDeploymentVerification } from "../../preview/production-verification-requirement.js";
import { loadHarnessConfig } from "../../config/load-config.js";
import { resolveHarnessWorkspaceRootFromConfigSource } from "../../config/workspace-root.js";
import {
  decideProductionSyncGate,
  isProductionSyncDurableComplete,
} from "../idempotency.js";
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
  resolveWorkflowStateStoreMode,
  WorkflowStateStoreError,
  mutateProductionCompletionCas,
  DurableStateCasExhaustedError,
  DurableStateUnavailableError,
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
  recordAcknowledgedProductionScore,
  safeStartPhaseTrace,
} from "../../evaluation/phase-helpers.js";
import type { EvaluationRuntime } from "../../evaluation/types.js";
import type { PhaseTraceHandle } from "../../evaluation/types.js";
import {
  ProductionSyncProjectionError,
  classifyProductionSyncError,
} from "../production-sync-errors.js";

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
}): Promise<{ store: WorkflowStateStore; state: WorkflowStateRecord }> {
  const mode = resolveWorkflowStateStoreMode();
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
  } catch (error) {
    if (mode === "managed_github" || error instanceof WorkflowStateStoreError) {
      const message =
        error instanceof Error
          ? error.message
          : "Managed durable workflow state is unavailable";
      throw new DurableStateUnavailableError(message);
    }
    throw error;
  }
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

async function persistCompletionMutation(input: {
  store: WorkflowStateStore;
  issueKey: string;
  seed: ProductionCompletionRecord;
  mutate: (latest: ProductionCompletionRecord) => ProductionCompletionRecord;
}): Promise<{
  state: WorkflowStateRecord;
  completion: ProductionCompletionRecord;
}> {
  const state = await mutateProductionCompletionCas({
    store: input.store,
    issueKey: input.issueKey,
    productionCompletionId: input.seed.productionCompletionId,
    seedIfMissing: () => input.seed,
    mutate: input.mutate,
  });
  const completion = state.productionCompletion;
  if (!completion) {
    throw new DurableStateUnavailableError(
      "Production completion missing after successful CAS",
    );
  }
  return { state, completion };
}

async function projectLangfuseEffect(input: {
  store: WorkflowStateStore;
  state: WorkflowStateRecord;
  issueKey: string;
  seed: ProductionCompletionRecord;
  completion: ProductionCompletionRecord;
  kind: ProductionEffectKind;
  runtime: EvaluationRuntime;
  sessionId: string;
  now: string;
  scoreTraceId?: string;
}): Promise<{
  state: WorkflowStateRecord;
  completion: ProductionCompletionRecord;
}> {
  if (isProductionEffectCompleted(input.completion, input.kind)) {
    return { state: input.state, completion: input.completion };
  }

  const milestone = milestoneForEffect(input.kind);
  try {
    if (milestone) {
      await recordAcknowledgedProductionScore(
        input.runtime,
        buildProductionMilestoneScore({
          namespace: input.runtime.namespace,
          sessionId: input.sessionId,
          milestone,
          productionCompletionId: input.completion.productionCompletionId,
          timestamp: input.now,
          traceId: input.scoreTraceId,
        }),
      );
    } else if (input.kind === "langfuse_delivery_outcome") {
      await recordAcknowledgedProductionScore(
        input.runtime,
        buildFinalProductionDeliveryOutcomeScore({
          namespace: input.runtime.namespace,
          sessionId: input.sessionId,
          productionCompletionId: input.completion.productionCompletionId,
          timestamp: input.now,
          traceId: input.scoreTraceId,
        }),
      );
    }
  } catch (error) {
    throw new ProductionSyncProjectionError(
      "langfuse_projection_failure",
      error instanceof Error ? error.message : String(error),
    );
  }

  return persistCompletionMutation({
    store: input.store,
    issueKey: input.issueKey,
    seed: input.seed,
    mutate: (latest) =>
      upsertProductionEffect(latest, input.kind, "completed", {
        now: input.now,
      }),
  });
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
  let linearStatusAfter: string | null = null;

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

        if (!mergeCommitSha && !prUrl) {
          finalOutcome = "skipped";
          errorClassification = "missing_merge_metadata";
          skippedReason = "missing_merge_metadata";
        } else {
          // 1-4: identity inputs → load durable state fail-closed → resolve completion
          const { store, state: initialState } = await loadWorkflowStateForIssue({
            issueKey: options.issueKey,
            config,
            teamId: issue.teamId,
          });
          let state = initialState;

          const targetRepository = markers.targetRepo ?? resolved.targetRepo;
          const identityMergeSha = mergeCommitSha ?? "pending-proof";
          let completion = resolveCompletionRecord(state, {
            issueKey: options.issueKey,
            targetRepository,
            mergeToDevSha: identityMergeSha,
            productionBranch: resolved.productionBranch,
          });
          productionCompletionId = completion.productionCompletionId;

          const gate = decideProductionSyncGate({
            issueStatus: issue.status,
            productionSuccessStatus,
            integrationSuccessStatus,
            completion,
            force: options.force,
          });

          if (gate.action === "fail") {
            finalOutcome = "failed";
            errorClassification = gate.classification;
            skippedReason = gate.reason;
          } else if (gate.action === "noop") {
            finalOutcome = "duplicate";
            errorClassification = "duplicate_phase_completed";
            skippedReason = gate.reason;
            productionState = completion.state;
          } else {
            const proof = await resolvePromotionProof({
              client: github,
              targetRepo: targetRepository,
              productionBranch: resolved.productionBranch,
              baseBranch: resolved.baseBranch,
              mergeCommitSha,
              prUrl,
              prNumber,
              issueKey: options.issueKey,
            });

            if (!proof.proof) {
              if (proof.reason === "promotion_method_unsupported") {
                const mergeShaForIdentity =
                  mergeCommitSha ??
                  proof.diagnosticIssueKeyCommits?.[0] ??
                  "unknown";
                const seed = resolveCompletionRecord(state, {
                  issueKey: options.issueKey,
                  targetRepository,
                  mergeToDevSha: mergeShaForIdentity,
                  productionBranch: resolved.productionBranch,
                });
                const persisted = await persistCompletionMutation({
                  store,
                  issueKey: options.issueKey,
                  seed,
                  mutate: (latest) =>
                    withProductionState(latest, "blocked", {
                      blockedReason: "promotion_method_unsupported",
                    }),
                });
                state = persisted.state;
                completion = persisted.completion;
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
              const seed = resolveCompletionRecord(state, {
                issueKey: options.issueKey,
                targetRepository,
                mergeToDevSha: proof.mergeCommitSha,
                productionBranch: resolved.productionBranch,
              });
              completion = seed;
              productionCompletionId = completion.productionCompletionId;

              // Re-check durable complete with authoritative merge sha
              if (
                !options.force &&
                isProductionSyncDurableComplete(completion) &&
                (issue.status?.toLowerCase() ?? "") ===
                  productionSuccessStatus.toLowerCase()
              ) {
                finalOutcome = "duplicate";
                errorClassification = "duplicate_phase_completed";
                skippedReason =
                  "duplicate_phase_completed: durable completion already complete";
                productionState = completion.state;
              } else {
                let persisted = await persistCompletionMutation({
                  store,
                  issueKey: options.issueKey,
                  seed,
                  mutate: (latest) =>
                    withProductionState(latest, "promotion_proven", {
                      firstProductionHeadContainingMerge: proof.productionHeadSha,
                      promotionSha: proof.productionHeadSha,
                    }),
                });
                state = persisted.state;
                completion = persisted.completion;

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

                const requiresVercelDeploy =
                  requiresVercelProductionDeploymentVerification({
                    previewProvider: resolved.previewProvider,
                  });

                if (!requiresVercelDeploy) {
                  persisted = await persistCompletionMutation({
                    store,
                    issueKey: options.issueKey,
                    seed: completion,
                    mutate: (latest) =>
                      withProductionState(latest, "blocked", {
                        blockedReason: "deployment_provider_not_configured",
                      }),
                  });
                  state = persisted.state;
                  completion = persisted.completion;
                  productionState = completion.state;
                  finalOutcome = "skipped";
                  skippedReason = "deployment_provider_not_configured";
                  errorClassification = null;
                } else {
                  const vercelToken = process.env.VERCEL_TOKEN;
                  if (!vercelToken) {
                    persisted = await persistCompletionMutation({
                      store,
                      issueKey: options.issueKey,
                      seed: completion,
                      mutate: (latest) =>
                        withProductionState(latest, "blocked", {
                          blockedReason: "vercel_token_missing",
                        }),
                    });
                    state = persisted.state;
                    completion = persisted.completion;
                    productionState = completion.state;
                    finalOutcome = "skipped";
                    skippedReason = "vercel_token_missing";
                    errorClassification = "production_not_promoted";
                  } else {
                    if (!options.dryRun) {
                      const promoted = await projectLangfuseEffect({
                        store,
                        state,
                        issueKey: options.issueKey,
                        seed: completion,
                        completion,
                        kind: "langfuse_promoted_to_main",
                        runtime: evaluationRuntime,
                        sessionId,
                        now,
                        scoreTraceId,
                      });
                      state = promoted.state;
                      completion = promoted.completion;

                      const started = await projectLangfuseEffect({
                        store,
                        state,
                        issueKey: options.issueKey,
                        seed: completion,
                        completion,
                        kind: "langfuse_production_deployment_started",
                        runtime: evaluationRuntime,
                        sessionId,
                        now,
                        scoreTraceId,
                      });
                      state = started.state;
                      completion = started.completion;
                    }

                    const deploy = await verifyVercelProductionDeployment({
                      vercelToken,
                      githubClient: github,
                      targetRepo: targetRepository,
                      productionBranch: resolved.productionBranch,
                      mergeToDevSha: proof.mergeCommitSha,
                      productionHeadSha: proof.productionHeadSha,
                    });

                    if (!deploy.verified) {
                      persisted = await persistCompletionMutation({
                        store,
                        issueKey: options.issueKey,
                        seed: completion,
                        mutate: (latest) =>
                          withProductionState(latest, "blocked", {
                            blockedReason: deploy.reason,
                            deploymentId: deploy.deploymentId,
                            deploymentSha: deploy.deploymentSha,
                          }),
                      });
                      state = persisted.state;
                      completion = persisted.completion;
                      productionState = completion.state;
                      finalOutcome = "skipped";
                      skippedReason = deploy.reason;
                      errorClassification = "production_not_promoted";
                    } else if (options.dryRun) {
                      productionState = "deployment_verified";
                      finalOutcome = "success";
                      skippedReason = "dry_run";
                    } else {
                      if (
                        !isProductionEffectCompleted(
                          completion,
                          "langfuse_production_deployment_ready",
                        )
                      ) {
                        const ready = await projectLangfuseEffect({
                          store,
                          state,
                          issueKey: options.issueKey,
                          seed: completion,
                          completion,
                          kind: "langfuse_production_deployment_ready",
                          runtime: evaluationRuntime,
                          sessionId,
                          now,
                          scoreTraceId,
                        });
                        state = ready.state;
                        completion = ready.completion;
                      }

                      persisted = await persistCompletionMutation({
                        store,
                        issueKey: options.issueKey,
                        seed: completion,
                        mutate: (latest) =>
                          withProductionState(latest, "deployment_verified", {
                            deploymentProvider: deploy.provider,
                            deploymentId: deploy.deploymentId,
                            deploymentSha: deploy.deploymentSha,
                            aliasSha: deploy.aliasSha,
                            productionAliasVerifiedAt: now,
                          }),
                      });
                      state = persisted.state;
                      completion = persisted.completion;

                      persisted = await persistCompletionMutation({
                        store,
                        issueKey: options.issueKey,
                        seed: completion,
                        mutate: (latest) =>
                          withProductionState(latest, "linear_projection_pending"),
                      });
                      state = persisted.state;
                      completion = persisted.completion;

                      const linearCommentEffect: ProductionEffectKind =
                        "linear_production_comment";
                      const linearStatusEffect: ProductionEffectKind =
                        "linear_status_transition";
                      const commentEffectId = buildProductionEffectId(
                        completion.productionCompletionId,
                        linearCommentEffect,
                      );

                      if (
                        !isProductionEffectCompleted(
                          completion,
                          linearCommentEffect,
                        )
                      ) {
                        const adoptable = findAdoptableProductionSyncComment({
                          comments,
                          orchestratorMarker: config.orchestratorMarker,
                          productionCompletionId:
                            completion.productionCompletionId,
                          productionEffectId: commentEffectId,
                          issueKey: options.issueKey,
                          targetRepository,
                          mergeToDevSha: proof.mergeCommitSha,
                          productionBranch: resolved.productionBranch,
                        });

                        if (!adoptable) {
                          const productionUrl =
                            resolved.productionUrl ?? deploy.deploymentUrl;
                          const promotionBody =
                            buildProductionPromotionCommentBody({
                              prUrl: prUrl ?? markers.prUrl ?? "",
                              branch: markers.branch ?? "unknown",
                              targetRepo: targetRepository,
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
                            targetRepo: targetRepository,
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
                            productionCompletionId:
                              completion.productionCompletionId,
                            productionEffectId: commentEffectId,
                          };
                          try {
                            await postProductionSyncComment(
                              client,
                              issue.id,
                              promotionBody,
                              footer,
                            );
                          } catch (error) {
                            throw new ProductionSyncProjectionError(
                              "linear_comment_failure",
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }

                        persisted = await persistCompletionMutation({
                          store,
                          issueKey: options.issueKey,
                          seed: completion,
                          mutate: (latest) =>
                            upsertProductionEffect(
                              latest,
                              linearCommentEffect,
                              "completed",
                              { now },
                            ),
                        });
                        state = persisted.state;
                        completion = persisted.completion;
                      }

                      if (
                        !isProductionEffectCompleted(
                          completion,
                          linearStatusEffect,
                        )
                      ) {
                        const statusNow = issue.status?.toLowerCase() ?? "";
                        if (statusNow === productionSuccessStatus.toLowerCase()) {
                          // Adopt authoritative Linear status — no transition.
                        } else if (
                          statusNow === integrationSuccessStatus.toLowerCase()
                        ) {
                          try {
                            await transitionIssueStatus(
                              client,
                              issue,
                              productionSuccessStatus,
                            );
                          } catch (error) {
                            throw new ProductionSyncProjectionError(
                              "linear_status_transition_failure",
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                          linearStatusAfter = productionSuccessStatus;
                        } else {
                          throw new ProductionSyncProjectionError(
                            "wrong_status",
                            `wrong_status: issue is "${issue.status}"; expected ${integrationSuccessStatus} or ${productionSuccessStatus}`,
                            { retryable: false },
                          );
                        }

                        persisted = await persistCompletionMutation({
                          store,
                          issueKey: options.issueKey,
                          seed: completion,
                          mutate: (latest) =>
                            upsertProductionEffect(
                              latest,
                              linearStatusEffect,
                              "completed",
                              { now },
                            ),
                        });
                        state = persisted.state;
                        completion = persisted.completion;
                      }

                      persisted = await persistCompletionMutation({
                        store,
                        issueKey: options.issueKey,
                        seed: completion,
                        mutate: (latest) =>
                          withProductionState(
                            latest,
                            "langfuse_projection_pending",
                          ),
                      });
                      state = persisted.state;
                      completion = persisted.completion;

                      for (const kind of [
                        "langfuse_production_verified",
                        "langfuse_delivery_outcome",
                      ] as const) {
                        const projected = await projectLangfuseEffect({
                          store,
                          state,
                          issueKey: options.issueKey,
                          seed: completion,
                          completion,
                          kind,
                          runtime: evaluationRuntime,
                          sessionId,
                          now,
                          scoreTraceId,
                        });
                        state = projected.state;
                        completion = projected.completion;
                      }

                      if (phaseTrace) {
                        phaseTrace.finish({
                          finalOutcome: "success",
                          errorClassification: null,
                          linearStatusAfter:
                            linearStatusAfter ?? productionSuccessStatus,
                          prCreated: false,
                          previewAvailable: Boolean(
                            resolved.productionUrl ?? deploy.deploymentUrl,
                          ),
                          changedFileCount: 0,
                        });
                        phaseTrace = null;
                      }

                      persisted = await persistCompletionMutation({
                        store,
                        issueKey: options.issueKey,
                        seed: completion,
                        mutate: (latest) =>
                          withProductionState(latest, "completed"),
                      });
                      state = persisted.state;
                      completion = persisted.completion;
                      productionState = completion.state;

                      const afterIssue = await fetchLinearIssue(
                        options.issueKey,
                        linearApiKey,
                      );
                      linearStatusAfter = afterIssue.status;
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
    }
  } catch (error) {
    finalOutcome = "failed";
    errorClassification =
      classifyProductionSyncError(error) ??
      classifyCanonicalGateError(error) ??
      (error instanceof DurableStateCasExhaustedError
        ? "durable_state_cas_exhausted"
        : error instanceof DurableStateUnavailableError ||
            error instanceof WorkflowStateStoreError
          ? "durable_state_unavailable"
          : error instanceof Error && error.message.includes("GITHUB_TOKEN")
            ? "github_auth_failure"
            : error instanceof Error &&
                error.message.includes("langfuse_projection_failure")
              ? "langfuse_projection_failure"
              : "github_api_failure");
    skippedReason = error instanceof Error ? error.message : String(error);
  } finally {
    if (evaluationRuntime) {
      try {
        await evaluationRuntime.flushAndShutdown();
      } catch {
        // Non-authoritative after acknowledged production scores.
      }
    }
  }

  const manifest: RunManifest = {
    runId,
    issueKey: options.issueKey,
    phase: "production_sync",
    phaseInferredFromStatus: null,
    linearStatusBefore: issue?.status ?? null,
    linearStatusAfter: linearStatusAfter ?? issue?.status ?? null,
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

// Keep type import used for comments in tests / future wiring
export type { LinearCommentRecord };
