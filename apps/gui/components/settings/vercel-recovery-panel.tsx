"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/custom/status-badge";
import { readSetupJsonResponse } from "@/lib/setup-json-response";
import type {
  VercelRecoveryNextAction,
  VercelRecoveryPublicStatus,
  VercelRecoveryStage,
} from "@harness/setup/vercel-connection-recovery-types";
import {
  isNonterminalRecoveryStage,
  vercelRecoveryStageLabel,
} from "@harness/setup/vercel-connection-recovery-types";
import { WORKFLOW_ROUTE } from "@harness/setup/gui-routes";
import { bridgeHealthLabel } from "@harness/setup/workspace-health";

const STAGES: VercelRecoveryStage[] = [
  "verifying_vercel",
  "preparing_bridge",
  "deploying_bridge",
  "verifying_webhook",
  "connecting_linear",
  "ready",
];

function nextActionLabel(action: VercelRecoveryNextAction): string {
  switch (action) {
    case "enter_different_token":
      return "Enter a different token";
    case "select_scope":
      return "Select a scope";
    case "select_bridge":
      return "Select a bridge";
    case "retry_deployment":
      return "Retry deployment";
    case "retry_verification":
      return "Retry verification";
    case "retry_linear_connection":
      return "Retry Linear connection";
    case "retry_recovery":
      return "Retry recovery";
    default:
      return "Continue";
  }
}

function shouldAutoAdvance(stage: VercelRecoveryStage | undefined): boolean {
  if (!stage) {
    return false;
  }
  return (
    stage === "verifying_vercel" ||
    stage === "preparing_bridge" ||
    stage === "deploying_bridge" ||
    stage === "verifying_webhook" ||
    stage === "connecting_linear"
  );
}

export function VercelRecoveryPanel({
  active,
  variant = "card",
  credentialSuccessMessage,
  onCredentialHealthRefresh,
  onActiveChange,
  suppressScopePrompt = false,
}: {
  active: boolean;
  variant?: "card" | "embedded";
  credentialSuccessMessage?: string | null;
  onCredentialHealthRefresh?: () => void;
  /** Notify parent when a durable nonterminal op is present. */
  onActiveChange?: (active: boolean) => void;
  /** When true, do not ask to re-select a scope already stored and in use. */
  suppressScopePrompt?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<VercelRecoveryPublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flightRef = useRef(false);
  const mountedRef = useRef(false);

  const runExclusive = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      if (flightRef.current) {
        return false;
      }
      flightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await fn();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Recovery failed.");
        return false;
      } finally {
        flightRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const refreshStatus = useCallback(async () => {
    const response = await fetch("/api/setup/vercel-connection-recovery/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const next = await readSetupJsonResponse<VercelRecoveryPublicStatus>(
      response,
      "POST /api/setup/vercel-connection-recovery/status",
    );
    setStatus(next);
    const nonterminal = Boolean(
      next.operation && isNonterminalRecoveryStage(next.operation.stage),
    );
    onActiveChange?.(nonterminal || next.operation?.stage === "ready");
    return next;
  }, [onActiveChange]);

  const advanceOnce = useCallback(async () => {
    const operationId = status?.operation?.operationId;
    if (!operationId) {
      return;
    }
    await runExclusive(async () => {
      const response = await fetch(
        "/api/setup/vercel-connection-recovery/advance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId,
            expectedRevision: status?.operation?.revision,
          }),
        },
      );
      if (response.status === 409) {
        await refreshStatus();
        return;
      }
      const next = await readSetupJsonResponse<VercelRecoveryPublicStatus>(
        response,
        "POST /api/setup/vercel-connection-recovery/advance",
      );
      setStatus(next);
      if (next.redirectToWorkflow || next.operation?.stage === "ready") {
        onCredentialHealthRefresh?.();
        router.push(WORKFLOW_ROUTE);
      }
    });
  }, [
    onCredentialHealthRefresh,
    refreshStatus,
    router,
    runExclusive,
    status?.operation?.operationId,
    status?.operation?.revision,
  ]);

  const startIfNeeded = useCallback(async () => {
    await runExclusive(async () => {
      const current = await refreshStatus();
      if (
        current.operation &&
        isNonterminalRecoveryStage(current.operation.stage)
      ) {
        return;
      }
      if (current.operation?.stage === "ready") {
        return;
      }
      const response = await fetch(
        "/api/setup/vercel-connection-recovery/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const next = await readSetupJsonResponse<VercelRecoveryPublicStatus>(
        response,
        "POST /api/setup/vercel-connection-recovery/start",
      );
      setStatus(next);
      if (next.redirectToWorkflow || next.operation?.stage === "ready") {
        onCredentialHealthRefresh?.();
        router.push(WORKFLOW_ROUTE);
      }
    });
  }, [onCredentialHealthRefresh, refreshStatus, router, runExclusive]);

  const selectScope = useCallback(
    async (selectedScope: { teamId?: string; teamName: string }) => {
      const operationId = status?.operation?.operationId;
      if (!operationId) {
        return;
      }
      await runExclusive(async () => {
        const response = await fetch(
          "/api/setup/vercel-connection-recovery/select-scope",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId,
              selectedScope,
              expectedRevision: status?.operation?.revision,
            }),
          },
        );
        if (response.status === 409) {
          await refreshStatus();
          return;
        }
        const next = await readSetupJsonResponse<VercelRecoveryPublicStatus>(
          response,
          "POST /api/setup/vercel-connection-recovery/select-scope",
        );
        setStatus(next);
      });
    },
    [
      refreshStatus,
      runExclusive,
      status?.operation?.operationId,
      status?.operation?.revision,
    ],
  );

  const selectBridge = useCallback(
    async (projectId: string) => {
      const operationId = status?.operation?.operationId;
      if (!operationId) {
        return;
      }
      await runExclusive(async () => {
        const response = await fetch(
          "/api/setup/vercel-connection-recovery/select-bridge",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId,
              projectId,
              expectedRevision: status?.operation?.revision,
            }),
          },
        );
        if (response.status === 409) {
          await refreshStatus();
          return;
        }
        const next = await readSetupJsonResponse<VercelRecoveryPublicStatus>(
          response,
          "POST /api/setup/vercel-connection-recovery/select-bridge",
        );
        setStatus(next);
      });
    },
    [
      refreshStatus,
      runExclusive,
      status?.operation?.operationId,
      status?.operation?.revision,
    ],
  );

  // On activate: load durable status; start only if none. Single controller.
  useEffect(() => {
    if (!active) {
      return;
    }
    if (mountedRef.current) {
      return;
    }
    mountedRef.current = true;
    void startIfNeeded();
    return () => {
      mountedRef.current = false;
    };
  }, [active, startIfNeeded]);

  // Bounded auto-advance: never overlaps exclusive mutate (flightRef).
  useEffect(() => {
    if (!active || !status?.operation) {
      return;
    }
    const stage = status.operation.stage;
    if (!shouldAutoAdvance(stage)) {
      return;
    }
    if (flightRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      void advanceOnce();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [active, advanceOnce, status?.operation?.revision, status?.operation?.stage]);

  if (!active) {
    return null;
  }

  const operation = status?.operation;
  const currentStage = operation?.stage;
  const hasScopeChoices = Boolean(operation?.scopeOptions?.length);
  const hasBridgeChoices = Boolean(operation?.bridgeCandidates?.length);
  const showInput =
    (currentStage === "needs_scope" && hasScopeChoices) ||
    (currentStage === "needs_bridge" && hasBridgeChoices);
  const showFailure =
    currentStage === "failed" ||
    Boolean(
      operation?.humanProblem &&
        (currentStage === "needs_scope" || currentStage === "needs_bridge") &&
        !showInput,
    );
  const showProgress =
    Boolean(operation) &&
    !showInput &&
    !showFailure &&
    currentStage !== "ready";

  // Nonterminal invariant: progress, input, or failure must be visible.
  const invariantOk =
    !operation ||
    currentStage === "ready" ||
    showProgress ||
    showInput ||
    showFailure ||
    busy ||
    Boolean(error);

  const shellClass =
    variant === "embedded"
      ? "space-y-4 border-t border-border pt-4 mt-4"
      : "rounded-lg border border-border bg-card p-4 space-y-4";

  return (
    <div className={shellClass} data-recovery-variant={variant}>
      {credentialSuccessMessage ? (
        <p className="text-sm text-muted-foreground">{credentialSuccessMessage}</p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Automation bridge recovery</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            PDev is repairing the Vercel bridge automatically. Stay on this page.
          </p>
          {operation?.selectedScope ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Scope: {operation.selectedScope.teamName}
            </p>
          ) : null}
        </div>
        {status ? (
          <StatusBadge
            label={bridgeHealthLabel(status.bridgeHealth)}
            variant={
              status.bridgeHealth === "verified"
                ? "success"
                : status.bridgeHealth === "unhealthy"
                  ? "destructive"
                  : "secondary"
            }
          />
        ) : null}
      </div>

      <ol className="space-y-2">
        {STAGES.map((stage) => {
          const label = vercelRecoveryStageLabel(stage);
          const isCurrent = currentStage === stage;
          const mapStage =
            currentStage === "needs_scope" ||
            currentStage === "needs_bridge" ||
            currentStage === "failed"
              ? "preparing_bridge"
              : currentStage;
          const currentIndex = mapStage ? STAGES.indexOf(mapStage) : -1;
          const stageIndex = STAGES.indexOf(stage);
          const done =
            currentStage === "ready" ||
            (currentIndex >= 0 && stageIndex < currentIndex);
          return (
            <li
              key={stage}
              className="flex items-center gap-2 text-sm"
              data-stage={stage}
              data-current={isCurrent ? "true" : undefined}
            >
              <span
                className={
                  done
                    ? "text-emerald-600"
                    : isCurrent || (showProgress && stage === mapStage)
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                }
              >
                {done ? "✓" : isCurrent || (showProgress && stage === mapStage) ? "→" : "·"}{" "}
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {showProgress || busy ? (
        <p className="text-sm text-muted-foreground" data-recovery-progress="true">
          {busy
            ? "Working…"
            : `In progress: ${vercelRecoveryStageLabel(currentStage ?? "preparing_bridge")}`}
        </p>
      ) : null}

      {currentStage === "needs_scope" &&
      operation?.scopeOptions?.length &&
      !suppressScopePrompt ? (
        <div className="space-y-2" data-recovery-input="scope">
          {operation.humanProblem ? (
            <p className="text-sm text-foreground">{operation.humanProblem}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a Vercel scope before PDev prepares the automation bridge.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {operation.scopeOptions.map((scope) => (
              <Button
                key={scope.teamId ?? "personal"}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void selectScope({
                    teamId: scope.teamId,
                    teamName: scope.teamName,
                  })
                }
              >
                {scope.teamName}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {currentStage === "needs_bridge" && operation?.bridgeCandidates?.length ? (
        <div className="space-y-2" data-recovery-input="bridge">
          <p className="text-sm text-foreground">
            {operation.humanProblem ??
              "Choose which PDev-marked bridge project to reuse."}
          </p>
          <div className="flex flex-wrap gap-2">
            {operation.bridgeCandidates.map((candidate) => (
              <Button
                key={candidate.projectId}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void selectBridge(candidate.projectId)}
              >
                {candidate.projectName}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {showFailure ? (
        <div
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-recovery-failure="true"
        >
          <p className="text-sm font-medium">
            {vercelRecoveryStageLabel(operation?.lastSuccessfulStage ?? "failed")}
            {" — "}
            {operation?.humanProblem ?? "Recovery needs attention."}
          </p>
          <p className="text-xs text-muted-foreground">
            Remote changes occurred:{" "}
            {operation?.remoteMutationsOccurred ? "yes" : "no"}. Retry is{" "}
            {operation?.retrySafe ? "safe" : "not recommended"}.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={
              busy ||
              (operation?.stage === "failed" && !operation.retrySafe)
            }
            onClick={() => void advanceOnce()}
          >
            {operation?.nextAction && operation.nextAction !== "none"
              ? nextActionLabel(operation.nextAction)
              : "Retry recovery"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <div
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-recovery-failure="true"
        >
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void advanceOnce()}
          >
            Retry recovery
          </Button>
        </div>
      ) : null}

      {!invariantOk ? (
        <div
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-recovery-failure="true"
        >
          <p className="text-sm font-medium">
            Recovery paused without a clear next step.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void advanceOnce()}
          >
            Continue recovery
          </Button>
        </div>
      ) : null}
    </div>
  );
}
