"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunnerUpgradeProgressState } from "@harness/setup/runner-upgrade-progress";
import type {
  RunnerUpgradePreviewResult,
  RunnerUpgradeStatusResult,
} from "@harness/setup/runner-upgrade-types";
import { runnerUpgradePhaseLabel } from "@harness/setup/runner-upgrade-types";
import { runnerUpgradeProgressShowsNoProgress } from "@harness/setup/runner-upgrade-timeouts";
import { Button } from "@/components/ui/button";
import {
  GuidedOperationPanel,
  buildGuidedOperationPhases,
} from "@/components/custom/guided-operation-panel";
import { SettingsMutationPanel } from "@/components/settings/settings-mutation-panel";
import {
  initialSettingsMutationState,
  sanitizeSettingsErrorMessage,
  type SettingsMutationState,
} from "@/lib/settings/settings-mutation";
import {
  formatRunnerUpgradeCurrentSnapshotLine,
  runnerUpgradeCanApply,
  runnerUpgradeCanPreview,
  runnerUpgradeRetryStatusVisible,
} from "@/lib/settings/runner-upgrade-ui-gates";
import {
  abortInFlightRunnerUpgradeStatusFetch,
  applyRunnerUpgrade,
  fetchRunnerUpgradeProgress,
  fetchRunnerUpgradeStatus,
  previewRunnerUpgrade,
} from "@/lib/settings/settings-setup-client";

const RUNNER_UPGRADE_PHASE_IDS = [
  "verifying-managed-repository",
  "comparing-runner-snapshots",
  "preparing-upgrade-commit",
  "updating-managed-runner",
  "verifying-runner-on-production-branch",
  "synchronizing-cloud-configuration",
  "running-configuration-canary",
] as const;

const RUNNER_UPGRADE_PHASE_LABELS = RUNNER_UPGRADE_PHASE_IDS.map((phase) =>
  runnerUpgradePhaseLabel(phase),
);

type ClientLifecycle =
  | "idle"
  | "submitting"
  | "accepted"
  | "running"
  | "success"
  | "failed";

type RunnerUpgradeSettingsCardProps = {
  initialStatus: RunnerUpgradeStatusResult | null;
};

function formatAvailableSnapshotLine(
  snapshot?: RunnerUpgradeStatusResult["currentSnapshot"],
): string {
  if (!snapshot) {
    return "Available runner: —";
  }
  return `Available runner: ${snapshot.packageVersion} (${snapshot.snapshotContentId.slice(0, 12)}…)`;
}

export function RunnerUpgradeSettingsCard({
  initialStatus,
}: RunnerUpgradeSettingsCardProps) {
  const [status, setStatus] = useState<RunnerUpgradeStatusResult | null>(
    initialStatus,
  );
  const [statusLoading, setStatusLoading] = useState(initialStatus === null);
  const [progress, setProgress] = useState<RunnerUpgradeProgressState | null>(
    null,
  );
  const [lifecycle, setLifecycle] = useState<ClientLifecycle>("idle");
  const [operationId, setOperationId] = useState<string | null>(
    initialStatus?.pendingOperationId ?? null,
  );
  const [mutation, setMutation] =
    useState<SettingsMutationState<RunnerUpgradePreviewResult>>(
      initialSettingsMutationState(),
    );
  const [confirmed, setConfirmed] = useState(false);
  const [noProgress, setNoProgress] = useState(false);

  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    abortInFlightRunnerUpgradeStatusFetch();
    setStatusLoading(true);
    try {
      const nextStatus = await fetchRunnerUpgradeStatus();
      if (mountedRef.current) {
        setStatus(nextStatus);
        setStatusLoading(false);
        if (nextStatus.pendingOperationId) {
          setOperationId(nextStatus.pendingOperationId);
        }
      }
      return nextStatus;
    } catch (error) {
      if (
        (error instanceof DOMException || error instanceof Error) &&
        error.name === "AbortError"
      ) {
        return null;
      }
      if (mountedRef.current) {
        setStatusLoading(false);
      }
      throw error;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const [nextProgress, nextStatus] = await Promise.all([
        fetchRunnerUpgradeProgress(),
        fetchRunnerUpgradeStatus(),
      ]);
      if (!mountedRef.current) {
        return;
      }
      setProgress(nextProgress);
      setStatus(nextStatus);
      setStatusLoading(false);
      if (nextStatus.pendingOperationId) {
        setOperationId(nextStatus.pendingOperationId);
      }
      setNoProgress(runnerUpgradeProgressShowsNoProgress(nextProgress));

      if (nextStatus.status === "up_to_date") {
        stopPolling();
        setLifecycle("success");
        setMutation({
          phase: "success",
          preview: null,
          error: null,
          successMessage: "PDev runner updated and configuration canary passed.",
        });
        setConfirmed(false);
        return;
      }
      if (
        nextStatus.status === "failed" ||
        nextStatus.status === "partially_updated" ||
        nextStatus.status === "blocked_operator_conflicts" ||
        nextStatus.status === "blocked_unexpected_remote" ||
        nextStatus.status === "blocked_non_managed"
      ) {
        if (nextStatus.status !== "partially_updated" || nextStatus.blockedReason) {
          stopPolling();
          setLifecycle(
            nextStatus.status === "partially_updated" ? "idle" : "failed",
          );
          if (nextStatus.blockedReason) {
            setMutation({
              phase: "error",
              preview: mutation.preview,
              error: sanitizeSettingsErrorMessage(nextStatus.blockedReason),
              successMessage: null,
            });
          }
        }
      }
    } catch {
      // Polling is best-effort.
    }
  }, [mutation.preview, stopPolling]);

  const startProgressPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void pollOnce();
    }, 2_000);
  }, [pollOnce, stopPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        await refreshStatus();
        const nextProgress = await fetchRunnerUpgradeProgress();
        if (!mountedRef.current) {
          return;
        }
        setProgress(nextProgress);
        if (
          nextProgress?.operationId ||
          status?.status === "updating" ||
          status?.status === "partially_updated"
        ) {
          if (nextProgress?.operationId) {
            setOperationId(nextProgress.operationId);
            setLifecycle("running");
            startProgressPolling();
          }
        }
      } catch {
        if (mountedRef.current) {
          setStatusLoading(false);
        }
      }
    })();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
    // Mount-only hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPreview = useCallback(async () => {
    setMutation((current) => ({ ...current, phase: "previewing", error: null }));
    setConfirmed(false);
    try {
      const preview = await previewRunnerUpgrade();
      if (preview.blocked) {
        throw new Error(preview.message ?? "Runner upgrade preview is blocked.");
      }
      setMutation({
        phase: "preview-ready",
        preview,
        error: null,
        successMessage: null,
      });
    } catch (error) {
      setMutation({
        phase: "error",
        preview: null,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Runner upgrade preview failed.",
        ),
        successMessage: null,
      });
    }
  }, []);

  const runApply = useCallback(async () => {
    if (!confirmed) {
      return;
    }
    setLifecycle("submitting");
    setMutation((current) => ({ ...current, phase: "applying", error: null }));
    setNoProgress(false);
    try {
      const resume =
        status?.status === "partially_updated" ||
        status?.status === "updating" ||
        status?.status === "failed";
      const result = await applyRunnerUpgrade({
        previewFingerprint: mutation.preview?.previewFingerprint,
        resume,
      });
      if (!mountedRef.current) {
        return;
      }
      setOperationId(result.apply.operationId);
      setProgress(result.progress);
      setStatus(result.status);
      setLifecycle("accepted");
      setLifecycle("running");
      startProgressPolling();
      void pollOnce();
    } catch (error) {
      stopPolling();
      setLifecycle("failed");
      setMutation({
        phase: "error",
        preview: mutation.preview,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Runner upgrade apply failed.",
        ),
        successMessage: null,
      });
    }
  }, [
    confirmed,
    mutation.preview,
    pollOnce,
    startProgressPolling,
    status?.status,
    stopPolling,
  ]);

  const activePhaseIndex = useMemo(() => {
    const phase = progress?.uiPhase ?? status?.pendingPhase;
    if (!phase || !operationId) {
      return -1;
    }
    const index = RUNNER_UPGRADE_PHASE_IDS.findIndex(
      (candidate) => candidate === phase,
    );
    return index >= 0 ? index : 0;
  }, [operationId, progress?.uiPhase, status?.pendingPhase]);

  const guidedPhases = buildGuidedOperationPhases({
    labels: RUNNER_UPGRADE_PHASE_LABELS,
    activeIndex: Math.max(activePhaseIndex, 0),
  });

  const tokenUnavailable = Boolean(
    status?.blockedReason?.includes("GITHUB_TOKEN is required"),
  );
  const lifecycleBusy =
    lifecycle === "submitting" ||
    lifecycle === "running" ||
    lifecycle === "accepted";
  const canPreview = runnerUpgradeCanPreview({
    status,
    tokenUnavailable,
    lifecycleBusy,
  });
  const canApply = runnerUpgradeCanApply({
    status,
    tokenUnavailable,
    lifecycleBusy,
  });
  const showRetryStatus = runnerUpgradeRetryStatusVisible(status);

  const canaryRunUrl = progress?.canaryRunUrl ?? status?.canaryRunUrl;
  const showRunningPanel =
    Boolean(operationId) &&
    (lifecycle === "running" ||
      lifecycle === "accepted" ||
      status?.status === "updating");
  const submitting = lifecycle === "submitting";

  return (
    <div className="space-y-6 rounded-md border border-border p-4">
      <div>
        <h3 className="text-base font-semibold tracking-tight">PDev runner</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the managed GitHub runner workspace that executes harness automation.
        </p>
      </div>

      <div className="rounded-md border border-border bg-muted/10 p-4 text-sm">
        <p>
          <span className="text-muted-foreground">Status:</span>{" "}
          {statusLoading || !status
            ? "Checking runner version"
            : status.statusLabel}
        </p>
        <p className="mt-2">{formatRunnerUpgradeCurrentSnapshotLine(status)}</p>
        <p className="mt-2">
          {formatAvailableSnapshotLine(status?.availableSnapshot)}
        </p>
        {status?.blockedReason && status.status !== "checking" ? (
          <p className="mt-2 text-destructive">{status.blockedReason}</p>
        ) : null}
        {status?.retryGuidance && status.degraded ? (
          <p className="mt-2 text-muted-foreground">{status.retryGuidance}</p>
        ) : null}
        {showRetryStatus ? (
          <div className="mt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={statusLoading || submitting}
              onClick={() => void refreshStatus()}
            >
              Retry status
            </Button>
          </div>
        ) : null}
        {status?.conflictPaths?.length ? (
          <div className="mt-2">
            <p className="text-muted-foreground">Conflict paths:</p>
            <ul className="mt-1 list-disc pl-5">
              {status.conflictPaths.slice(0, 8).map((conflictPath) => (
                <li key={conflictPath}>{conflictPath}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {status?.prUrl ? (
          <p className="mt-2">
            <span className="text-muted-foreground">Upgrade PR:</span>{" "}
            <a href={status.prUrl} className="underline" target="_blank" rel="noreferrer">
              View pull request
            </a>
          </p>
        ) : null}
      </div>

      {tokenUnavailable ? (
        <p className="text-sm text-muted-foreground">
          Connect GitHub in{" "}
          <Link href="/settings/connections" className="underline">
            Settings → Connections
          </Link>{" "}
          to check or update the managed runner.
        </p>
      ) : null}

      {mutation.preview && !mutation.preview.blocked ? (
        <div className="rounded-md border border-border p-4 text-sm">
          <p>
            <span className="text-muted-foreground">Impact:</span>{" "}
            {mutation.preview.impact.replacePathCount} replace,{" "}
            {mutation.preview.impact.deletePathCount} delete
          </p>
          {mutation.preview.impact.sampleReplacePaths.length > 0 ? (
            <p className="mt-2 text-muted-foreground">
              Sample replace paths:{" "}
              {mutation.preview.impact.sampleReplacePaths.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {submitting ? (
        <p className="text-sm text-muted-foreground">Starting update…</p>
      ) : null}

      {showRunningPanel && activePhaseIndex >= 0 ? (
        <GuidedOperationPanel
          phases={guidedPhases}
          supportingText={
            canaryRunUrl
              ? "Waiting for configuration canary to finish."
              : "Runner upgrade in progress."
          }
          busy
        />
      ) : null}

      {noProgress && showRunningPanel ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p>The runner update has not made progress recently.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setConfirmed(true);
                void runApply();
              }}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void refreshStatus()}
            >
              Refresh status
            </Button>
          </div>
        </div>
      ) : null}

      {canaryRunUrl ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Configuration canary:</span>{" "}
          <a href={canaryRunUrl} className="underline" target="_blank" rel="noreferrer">
            View workflow run
          </a>
        </p>
      ) : null}

      <SettingsMutationPanel
        title="Update PDev runner"
        explanation="Apply the packaged runner snapshot to the managed harness repository, sync cloud configuration, and run the configuration canary."
        phase={mutation.phase}
        error={mutation.error}
        successMessage={mutation.successMessage}
        previewPolicy="optional"
        previewSummary={
          mutation.preview?.blocked
            ? mutation.preview.message ?? "Runner upgrade preview is blocked."
            : mutation.preview
              ? `Replace ${mutation.preview.impact.replacePathCount} paths and delete ${mutation.preview.impact.deletePathCount} paths.`
              : null
        }
        confirmScope="remote-repo-write"
        confirmed={confirmed}
        onConfirmedChange={setConfirmed}
        onPreview={() => void runPreview()}
        onApply={() => void runApply()}
        previewLabel="Preview runner update"
        applyLabel="Update runner"
        disablePreview={!canPreview || submitting}
        disableApply={!canApply || !confirmed || submitting}
      />

      {status?.status === "partially_updated" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submitting || lifecycle === "running"}
            onClick={() => {
              setConfirmed(true);
              void runApply();
            }}
          >
            Resume runner upgrade
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={() => void refreshStatus()}
          >
            Refresh status
          </Button>
        </div>
      ) : null}
    </div>
  );
}
