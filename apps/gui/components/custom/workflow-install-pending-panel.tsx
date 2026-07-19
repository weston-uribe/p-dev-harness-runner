"use client";

import type { TargetWorkflowFinalizationResult } from "@harness/setup/target-workflow-finalization-types";
import {
  WORKFLOW_INSTALL_UI_PHASE_LABELS,
  WORKFLOW_INSTALL_UI_PHASES,
} from "@harness/setup/target-workflow-finalization-types";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/custom/status-badge";
import {
  GuidedOperationPanel,
  buildGuidedOperationPhases,
} from "@/components/custom/guided-operation-panel";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";

interface WorkflowInstallProgressPanelProps {
  finalization: TargetWorkflowFinalizationResult;
  onRetry?: () => void;
  retrying?: boolean;
  variant?: "guided" | "advanced";
  transientMessage?: string | null;
  onContinue?: () => void;
}

function activePhaseIndex(finalization: TargetWorkflowFinalizationResult): number {
  const index = WORKFLOW_INSTALL_UI_PHASES.indexOf(finalization.phase);
  if (index >= 0) {
    return index;
  }
  return 0;
}

export function WorkflowInstallProgressPanel({
  finalization,
  onRetry,
  retrying = false,
  variant = "advanced",
  transientMessage = null,
  onContinue,
}: WorkflowInstallProgressPanelProps) {
  const blocked =
    finalization.lifecycle === "blocked" && !finalization.retryable;
  const complete = finalization.lifecycle === "complete";
  const showGitHubDetails =
    variant === "advanced" &&
    blocked &&
    finalization.requiresGitHubIntervention &&
    finalization.prUrl;

  if (complete && variant === "guided") {
    const details = [
      finalization.branchName
        ? `Install branch: ${finalization.branchName}`
        : null,
      finalization.prNumber
        ? `Pull request #${finalization.prNumber} merged`
        : null,
      "Production workflow verified.",
      finalization.supersededPrNumber
        ? `Superseded empty PR #${finalization.supersededPrNumber}.`
        : null,
    ].filter((value): value is string => Boolean(value));
    return (
      <GuidedStepSuccessPanel
        heading="Workflow installed"
        explanation="The harness workflow is verified on the production branch."
        details={details}
        continueLabel="Continue to finish setup"
        onContinue={onContinue ?? (() => undefined)}
      />
    );
  }

  if (blocked) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 space-y-3">
        <StatusBadge label="Workflow install blocked" variant="destructive" />
        <p className="text-sm text-muted-foreground">{finalization.message}</p>
        <p className="text-xs text-muted-foreground">
          Failed phase:{" "}
          {WORKFLOW_INSTALL_UI_PHASE_LABELS[finalization.phase] ??
            finalization.phase}
          {finalization.prUrl ? (
            <>
              {" · "}
              <a
                href={finalization.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Open PR
              </a>
            </>
          ) : null}
        </p>
        {finalization.lastSafeCheckpoint ? (
          <p className="text-xs text-muted-foreground">
            Last checkpoint: {finalization.lastSafeCheckpoint}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {finalization.canRetry && onRetry ? (
            <Button type="button" onClick={onRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
          {showGitHubDetails ? (
            <Button asChild variant="outline">
              <a
                href={finalization.prUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open GitHub details
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const labels = WORKFLOW_INSTALL_UI_PHASES.map(
    (phase) => WORKFLOW_INSTALL_UI_PHASE_LABELS[phase],
  );
  const phases = buildGuidedOperationPhases({
    labels,
    activeIndex: activePhaseIndex(finalization),
  });

  return (
    <div className="space-y-3">
      <GuidedOperationPanel
        phases={phases}
        supportingText={transientMessage ?? finalization.message}
        busy={finalization.lifecycle !== "complete"}
      />
      {transientMessage ? (
        <p className="text-xs text-muted-foreground">
          Temporarily unable to refresh GitHub status.
          {finalization.lastSafeCheckpoint
            ? ` Last checkpoint: ${finalization.lastSafeCheckpoint}.`
            : ""}
          {finalization.updatedAt
            ? ` Last updated: ${new Date(finalization.updatedAt).toLocaleTimeString()}.`
            : ""}
        </p>
      ) : null}
      {finalization.prUrl ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Install details</summary>
          <p className="mt-2 break-all">PR: {finalization.prUrl}</p>
          <p className="mt-1">Operation: {finalization.operationId}</p>
        </details>
      ) : null}
    </div>
  );
}

interface WorkflowInstallReadyPanelProps {
  repoConfigId: string;
  onContinue?: () => void;
}

export function WorkflowInstallReadyPanel({
  repoConfigId,
  onContinue,
}: WorkflowInstallReadyPanelProps) {
  if (onContinue) {
    return (
      <GuidedStepSuccessPanel
        heading="Workflow ready"
        explanation={`${repoConfigId} has the expected harness workflow on its production branch.`}
        continueLabel="Continue to finish setup"
        onContinue={onContinue}
      />
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/20 p-4 space-y-2">
      <StatusBadge label="Workflow ready" variant="success" />
      <p className="text-sm text-muted-foreground">
        {repoConfigId} has the expected harness workflow on its production branch.
      </p>
    </div>
  );
}
