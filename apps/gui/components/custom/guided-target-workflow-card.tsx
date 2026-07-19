"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteTargetWorkflowApplyResult } from "@harness/setup/remote-actions";
import type { RemoteSetupSummary } from "@harness/setup/remote-setup-summary";
import type { RemoteWorkflowStatus } from "@harness/setup/remote-actions";
import type { TargetWorkflowFinalizationResult } from "@harness/setup/target-workflow-finalization-types";
import {
  WORKFLOW_INSTALL_BASE_RETRY_MS,
  WORKFLOW_INSTALL_MAX_RETRY_MS,
  WORKFLOW_INSTALL_MAX_TRANSIENT_RETRIES,
  WORKFLOW_INSTALL_SHORT_POLL_INTERVAL_MS,
} from "@harness/setup/target-workflow-finalization-types";

import { SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { SectionCard } from "@/components/custom/section-card";
import { TargetWorkflowPrCard } from "@/components/custom/target-workflow-pr-card";
import {
  WorkflowInstallProgressPanel,
  WorkflowInstallReadyPanel,
} from "@/components/custom/workflow-install-pending-panel";

interface GuidedTargetWorkflowCardProps {
  initialSummary: RemoteSetupSummary;
  onSummaryUpdated?: (summary: RemoteSetupSummary) => void;
  onWorkflowSetupComplete?: () => void;
  onWorkflowAwaitingMergeChange?: (awaiting: boolean) => void;
  onStepCompleted?: () => void;
  onContinue?: () => void;
  pendingInstallByRepo?: Record<string, RemoteTargetWorkflowApplyResult>;
  finalizationByRepo?: Record<string, TargetWorkflowFinalizationResult>;
  onPendingInstallChange?: (
    pending: Record<string, RemoteTargetWorkflowApplyResult>,
  ) => void;
  onFinalizationChange?: (
    finalization: Record<string, TargetWorkflowFinalizationResult>,
  ) => void;
  blockedByUpstream?: boolean;
}

function workflowStatusLabel(status: RemoteWorkflowStatus): string {
  switch (status) {
    case "present":
      return "workflow ready";
    case "missing":
      return "workflow missing";
    case "differs":
      return "workflow outdated";
    default:
      return "workflow status unknown";
  }
}

function allTargetWorkflowsReady(summary: RemoteSetupSummary): boolean {
  return (
    summary.targetRepos.length > 0 &&
    summary.targetRepos.every((repo) => repo.workflowStatus === "present")
  );
}

export { allTargetWorkflowsReady };

function isPendingInstallResult(
  result: RemoteTargetWorkflowApplyResult,
): boolean {
  return (
    result.outcome === "pr-created" ||
    result.outcome === "pr-updated" ||
    result.outcome === "branch-updated"
  );
}

function isTerminalFinalization(
  finalization: TargetWorkflowFinalizationResult | undefined,
): boolean {
  if (!finalization) {
    return false;
  }
  if (finalization.lifecycle === "complete") {
    return true;
  }
  return finalization.lifecycle === "blocked" && !finalization.retryable;
}

function shouldContinuePolling(
  finalization: TargetWorkflowFinalizationResult | undefined,
): boolean {
  if (!finalization) {
    return false;
  }
  if (isTerminalFinalization(finalization)) {
    return false;
  }
  return true;
}

function isRecoveringInstallBranch(
  finalization: TargetWorkflowFinalizationResult,
): boolean {
  return (
    finalization.lifecycle === "updating-branch" &&
    finalization.message.includes("Refreshing")
  );
}

function isNewerFinalization(
  existing: TargetWorkflowFinalizationResult | undefined,
  incoming: TargetWorkflowFinalizationResult,
): boolean {
  if (!existing) {
    return true;
  }
  if (isTerminalFinalization(existing) && !isTerminalFinalization(incoming)) {
    return false;
  }
  if (
    existing.validatedHeadSha &&
    incoming.validatedHeadSha &&
    existing.validatedHeadSha !== incoming.validatedHeadSha
  ) {
    return incoming.advancedThisRequest;
  }
  if (isRecoveringInstallBranch(incoming)) {
    return true;
  }
  return incoming.advancedThisRequest || !existing.lockContended;
}

function backoffDelayMs(failureCount: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? WORKFLOW_INSTALL_BASE_RETRY_MS;
  const exponential = Math.min(
    WORKFLOW_INSTALL_MAX_RETRY_MS,
    base * 2 ** Math.max(0, failureCount - 1),
  );
  const jitter = Math.floor(Math.random() * WORKFLOW_INSTALL_BASE_RETRY_MS);
  return Math.min(WORKFLOW_INSTALL_MAX_RETRY_MS, exponential + jitter);
}

function createPreparingFinalization(
  repo: RemoteSetupSummary["targetRepos"][number],
  pending: RemoteTargetWorkflowApplyResult,
): TargetWorkflowFinalizationResult {
  return {
    repoConfigId: repo.repoConfigId,
    targetRepo: repo.targetRepo,
    targetRepoSlug: repo.targetRepo,
    productionBranch: repo.productionBranch,
    branchName: pending.branchName,
    lifecycle: "preparing",
    phase: "preparing-workflow-installation",
    operationId: crypto.randomUUID(),
    message: "Starting automatic workflow install finalization.",
    workflowStatus: repo.workflowStatus,
    canRetry: true,
    retryable: true,
    retryAfterMs: WORKFLOW_INSTALL_SHORT_POLL_INTERVAL_MS,
    lastSafeCheckpoint: "preparing",
    errorCode: "none",
    requiresGitHubIntervention: false,
    advancedThisRequest: false,
    lockContended: false,
    updatedAt: new Date().toISOString(),
  };
}

export function GuidedTargetWorkflowCard({
  initialSummary,
  onSummaryUpdated,
  onWorkflowSetupComplete,
  onWorkflowAwaitingMergeChange,
  onStepCompleted,
  onContinue,
  pendingInstallByRepo = {},
  finalizationByRepo = {},
  onPendingInstallChange,
  onFinalizationChange,
  blockedByUpstream = false,
}: GuidedTargetWorkflowCardProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [localFinalizationByRepo, setLocalFinalizationByRepo] = useState(
    finalizationByRepo,
  );
  const [transientByRepo, setTransientByRepo] = useState<
    Record<string, string | null>
  >({});
  const [hideApplyByRepo, setHideApplyByRepo] = useState<Record<string, boolean>>(
    {},
  );
  const pollGenerationRef = useRef(0);
  const failureCountRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setSummary(initialSummary);
  }, [initialSummary]);

  useEffect(() => {
    setLocalFinalizationByRepo(finalizationByRepo);
  }, [finalizationByRepo]);

  const refreshSummary = useCallback(async () => {
    const response = await fetch("/api/setup/remote-summary");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Remote summary refresh failed");
    }
    const nextSummary = data as RemoteSetupSummary;
    setSummary(nextSummary);
    onSummaryUpdated?.(nextSummary);
    return nextSummary;
  }, [onSummaryUpdated]);

  const finalizeRepo = useCallback(
    async (repoConfigId: string, apply?: RemoteTargetWorkflowApplyResult) => {
      const repo = summary.targetRepos.find(
        (entry) => entry.repoConfigId === repoConfigId,
      );
      if (!repo) {
        return;
      }

      const existing = localFinalizationByRepo[repoConfigId];
      const response = await fetch("/api/setup/finalize-target-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoConfigId: repo.repoConfigId,
          targetRepo: repo.targetRepo,
          productionBranch: repo.productionBranch,
          prUrl: apply?.prUrl ?? existing?.prUrl,
          branchName: apply?.branchName ?? existing?.branchName,
          operationId: existing?.operationId,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error ?? "Workflow finalization failed") as Error & {
          retryable?: boolean;
          retryAfterMs?: number;
          errorCode?: string;
        };
        error.retryable = data.retryable === true;
        error.retryAfterMs = typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined;
        error.errorCode = typeof data.errorCode === "string" ? data.errorCode : undefined;
        throw error;
      }

      const finalization = data.finalization as TargetWorkflowFinalizationResult;
      const nextSummary = data.summary as RemoteSetupSummary;

      if (!mountedRef.current) {
        return finalization;
      }

      setLocalFinalizationByRepo((previous) => {
        const current = previous[repoConfigId];
        if (!isNewerFinalization(current, finalization)) {
          return previous;
        }
        const next = { ...previous, [repoConfigId]: finalization };
        onFinalizationChange?.(next);
        return next;
      });

      setSummary(nextSummary);
      onSummaryUpdated?.(nextSummary);

      if (finalization.lifecycle === "complete") {
        const nextPending = { ...pendingInstallByRepo };
        delete nextPending[repoConfigId];
        onPendingInstallChange?.(nextPending);
        onStepCompleted?.();
      }

      return finalization;
    },
    [
      localFinalizationByRepo,
      onFinalizationChange,
      onPendingInstallChange,
      onStepCompleted,
      onSummaryUpdated,
      pendingInstallByRepo,
      summary.targetRepos,
    ],
  );

  const startPolling = useCallback(
    (repoConfigId: string, apply?: RemoteTargetWorkflowApplyResult) => {
      const generation = pollGenerationRef.current + 1;
      pollGenerationRef.current = generation;
      failureCountRef.current[repoConfigId] = 0;

      const poll = async () => {
        while (pollGenerationRef.current === generation) {
          try {
            const finalization = await finalizeRepo(repoConfigId, apply);
            if (!mountedRef.current || pollGenerationRef.current !== generation) {
              break;
            }
            if (finalization?.lockContended) {
              setTransientByRepo((prev) => ({ ...prev, [repoConfigId]: null }));
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  finalization.retryAfterMs ?? WORKFLOW_INSTALL_SHORT_POLL_INTERVAL_MS,
                ),
              );
              continue;
            }
            failureCountRef.current[repoConfigId] = 0;
            setTransientByRepo((prev) => ({ ...prev, [repoConfigId]: null }));
            if (!shouldContinuePolling(finalization)) {
              break;
            }
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                finalization?.retryAfterMs ?? WORKFLOW_INSTALL_SHORT_POLL_INTERVAL_MS,
              ),
            );
          } catch (error) {
            if (!mountedRef.current || pollGenerationRef.current !== generation) {
              break;
            }
            const typed = error as Error & {
              retryable?: boolean;
              retryAfterMs?: number;
            };
            const failures = (failureCountRef.current[repoConfigId] ?? 0) + 1;
            failureCountRef.current[repoConfigId] = failures;
            const retryable = typed.retryable !== false;
            if (!retryable || failures > WORKFLOW_INSTALL_MAX_TRANSIENT_RETRIES) {
              setLocalFinalizationByRepo((previous) => {
                const existing = previous[repoConfigId];
                if (!existing) {
                  return previous;
                }
                const terminal: TargetWorkflowFinalizationResult = {
                  ...existing,
                  lifecycle: "blocked",
                  retryable: false,
                  canRetry: true,
                  errorCode: "retry_budget_exhausted",
                  message:
                    existing.message ||
                    "Workflow install polling stopped after repeated refresh failures.",
                  updatedAt: new Date().toISOString(),
                };
                const next = { ...previous, [repoConfigId]: terminal };
                onFinalizationChange?.(next);
                return next;
              });
              setTransientByRepo((prev) => ({ ...prev, [repoConfigId]: null }));
              break;
            }
            setTransientByRepo((prev) => ({
              ...prev,
              [repoConfigId]: "Temporarily unable to refresh GitHub status.",
            }));
            await new Promise((resolve) =>
              setTimeout(resolve, backoffDelayMs(failures, typed.retryAfterMs)),
            );
          }
        }
      };

      void poll();
    },
    [finalizeRepo, onFinalizationChange],
  );

  useEffect(() => {
    const awaiting = Object.entries(localFinalizationByRepo).some(([, state]) =>
      shouldContinuePolling(state),
    );
    onWorkflowAwaitingMergeChange?.(awaiting);
  }, [localFinalizationByRepo, onWorkflowAwaitingMergeChange]);

  useEffect(() => {
    for (const [repoConfigId, apply] of Object.entries(pendingInstallByRepo)) {
      if (!isPendingInstallResult(apply)) {
        continue;
      }
      const existing = localFinalizationByRepo[repoConfigId];
      if (existing && isTerminalFinalization(existing)) {
        continue;
      }
      if (!existing || shouldContinuePolling(existing)) {
        startPolling(repoConfigId, apply);
      }
    }
  }, [localFinalizationByRepo, pendingInstallByRepo, startPolling]);

  const handleGuidedApplySuccess = useCallback(
    async (
      repoConfigId: string,
      result: RemoteTargetWorkflowApplyResult,
      initialFinalization?: TargetWorkflowFinalizationResult,
    ) => {
      setHideApplyByRepo((prev) => ({ ...prev, [repoConfigId]: true }));
      let nextPending = { ...pendingInstallByRepo };

      if (result.outcome === "already-installed") {
        delete nextPending[repoConfigId];
        onPendingInstallChange?.(nextPending);
        await refreshSummary();
        onStepCompleted?.();
        return;
      }

      if (isPendingInstallResult(result)) {
        nextPending[repoConfigId] = result;
      }

      onPendingInstallChange?.(nextPending);

      if (initialFinalization) {
        const next = {
          ...localFinalizationByRepo,
          [repoConfigId]: initialFinalization,
        };
        setLocalFinalizationByRepo(next);
        onFinalizationChange?.(next);
      }

      if (isPendingInstallResult(result)) {
        startPolling(repoConfigId, result);
      }
    },
    [
      localFinalizationByRepo,
      onFinalizationChange,
      onPendingInstallChange,
      onStepCompleted,
      pendingInstallByRepo,
      refreshSummary,
      startPolling,
    ],
  );

  const awaitingFinalization = Object.values(localFinalizationByRepo).some(
    (state) => shouldContinuePolling(state),
  );
  const allComplete =
    allTargetWorkflowsReady(summary) ||
    (summary.targetRepos.length > 0 &&
      summary.targetRepos.every((repo) => {
        const finalization = localFinalizationByRepo[repo.repoConfigId];
        return (
          repo.workflowStatus === "present" ||
          finalization?.lifecycle === "complete"
        );
      }));

  const handleContinueWhenAllComplete = useCallback(async () => {
    if (!allComplete) {
      return;
    }

    let authoritativeSummary: RemoteSetupSummary;
    try {
      authoritativeSummary = await refreshSummary();
    } catch {
      return;
    }

    if (!allTargetWorkflowsReady(authoritativeSummary)) {
      return;
    }

    onWorkflowSetupComplete?.();
    onContinue?.();
  }, [
    allComplete,
    onContinue,
    onWorkflowSetupComplete,
    refreshSummary,
  ]);

  return (
    <SectionCard
      title={`Step 7 of ${GUIDED_SETUP_STEP_COUNT} · Install target repo workflow`}
      description={
        awaitingFinalization
          ? "Installing the harness workflow. Continue when production verification succeeds."
          : "The harness will create or reuse a workflow install PR, merge it automatically when GitHub permits, and verify the production workflow."
      }
    >
      <div className={SPACING.stackSm}>
        <p className="text-sm text-muted-foreground">
          Each target repo gets a deterministic install branch and PR. The harness
          finalizes the install automatically when checks and branch protection allow.
        </p>

        {summary.targetRepos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Resolve your local harness config to show target repo workflow cards.
          </p>
        ) : (
          <div className={SPACING.stackSm}>
            {summary.targetRepos.map((repo) => {
              const pending = pendingInstallByRepo[repo.repoConfigId];
              const finalization = localFinalizationByRepo[repo.repoConfigId];
              const workflowReady =
                repo.workflowStatus === "present" ||
                finalization?.lifecycle === "complete";
              const hideApply =
                hideApplyByRepo[repo.repoConfigId] ||
                Boolean(finalization) ||
                Boolean(pending && isPendingInstallResult(pending));

              return (
                <div
                  key={repo.repoConfigId}
                  className="rounded-md border border-border bg-background p-4 space-y-3"
                >
                  <div>
                    <p className="text-sm font-medium">{repo.repoConfigId}</p>
                    <p className="text-sm text-muted-foreground break-all">
                      {repo.targetRepo}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Status: {workflowStatusLabel(repo.workflowStatus)}
                    </p>
                  </div>

                  {workflowReady ? (
                    <WorkflowInstallReadyPanel
                      repoConfigId={repo.repoConfigId}
                      onContinue={
                        allComplete
                          ? () => {
                              void handleContinueWhenAllComplete();
                            }
                          : undefined
                      }
                    />
                  ) : finalization ? (
                    <WorkflowInstallProgressPanel
                      variant="guided"
                      finalization={finalization}
                      transientMessage={transientByRepo[repo.repoConfigId]}
                      onContinue={
                        allComplete && finalization.lifecycle === "complete"
                          ? () => {
                              void handleContinueWhenAllComplete();
                            }
                          : undefined
                      }
                      onRetry={
                        finalization.canRetry || finalization.retryable
                          ? () => {
                              failureCountRef.current[repo.repoConfigId] = 0;
                              startPolling(repo.repoConfigId, pending);
                            }
                          : undefined
                      }
                    />
                  ) : pending && isPendingInstallResult(pending) ? (
                    <WorkflowInstallProgressPanel
                      variant="guided"
                      finalization={createPreparingFinalization(repo, pending)}
                    />
                  ) : hideApply ? null : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Confirm to create or update the workflow install PR.
                        Preview is optional. Finalization runs automatically after apply.
                      </p>
                      <TargetWorkflowPrCard
                        repo={repo}
                        variant="guided"
                        onApplied={() => undefined}
                        onGuidedApplySuccess={(result, nextFinalization) =>
                          void handleGuidedApplySuccess(
                            repo.repoConfigId,
                            result,
                            nextFinalization,
                          )
                        }
                        blockedByUpstream={blockedByUpstream}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
