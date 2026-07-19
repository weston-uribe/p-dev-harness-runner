"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Lock,
  XCircle,
} from "lucide-react";
import type {
  FirstRunReadiness,
  FirstRunStep,
  FirstRunStepStatus,
} from "@harness/setup/first-run-readiness";

import { SPACING } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/custom/status-badge";
import { Button } from "@/components/ui/button";

function statusVariant(
  status: FirstRunStepStatus,
  setupNeeded = false,
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "complete":
      return "success";
    case "blocked":
      return setupNeeded ? "secondary" : "destructive";
    case "ready":
    case "in_progress":
      return setupNeeded ? "secondary" : "warning";
    default:
      return "secondary";
  }
}

function statusLabel(
  status: FirstRunStepStatus,
  setupNeeded = false,
): string {
  switch (status) {
    case "not_started":
      return "Not started";
    case "in_progress":
      return setupNeeded ? "Setup needed" : "In progress";
    case "blocked":
      return setupNeeded ? "Setup needed" : "Blocked";
    case "ready":
      return "Ready";
    case "complete":
      return "Complete";
  }
}

function StepIcon({
  step,
  setupNeeded,
}: {
  step: FirstRunStep;
  setupNeeded: boolean;
}) {
  if (step.status === "complete") {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />;
  }
  if (step.status === "blocked" && !setupNeeded) {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  if (step.status === "not_started") {
    return <Lock className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <Circle className="size-4 shrink-0 text-muted-foreground" />;
}

interface FirstRunStepperProps {
  readiness: FirstRunReadiness;
  renderStepContent: (stepId: FirstRunStep["id"]) => React.ReactNode;
  onSwitchToAdvanced?: () => void;
}

export function FirstRunStepper({
  readiness,
  renderStepContent,
  onSwitchToAdvanced,
}: FirstRunStepperProps) {
  const [expandedStepId, setExpandedStepId] = useState(
    readiness.currentStepId,
  );

  useEffect(() => {
    setExpandedStepId(readiness.currentStepId);
  }, [readiness.currentStepId]);

  return (
    <div className={SPACING.section}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={SPACING.stackSm}>
          <h3 className="text-lg font-semibold">First-run readiness flow</h3>
          <p className="text-sm text-muted-foreground">
            Complete each step in order. Later steps stay inspectable until
            prerequisites are ready.
          </p>
        </div>
        {onSwitchToAdvanced ? (
          <Button type="button" variant="outline" onClick={onSwitchToAdvanced}>
            Show all setup sections
          </Button>
        ) : null}
      </div>

      <ol className={SPACING.list}>
        {readiness.steps.map((step) => {
          const isCurrent = step.id === readiness.currentStepId;
          const expanded = expandedStepId === step.id;
          const canExpand = step.inspectable;
          const setupNeeded =
            step.blockers.length > 0 &&
            step.blockers.every((blocker) => blocker.tone === "setup_needed");

          return (
            <li
              key={step.id}
              className={cn(
                "rounded-lg border border-border",
                isCurrent && "border-primary/40 shadow-sm",
              )}
            >
              <button
                type="button"
                className="flex w-full cursor-pointer items-start gap-3 p-4 text-left disabled:cursor-not-allowed"
                onClick={() => {
                  if (canExpand) {
                    setExpandedStepId(expanded ? readiness.currentStepId : step.id);
                  }
                }}
                disabled={!canExpand}
              >
                <StepIcon step={step} setupNeeded={setupNeeded} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{step.label}</p>
                    <StatusBadge
                      label={statusLabel(step.status, setupNeeded)}
                      variant={statusVariant(step.status, setupNeeded)}
                    />
                    {isCurrent ? (
                      <StatusBadge label="Current" variant="secondary" />
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{step.summary}</p>
                  {step.primaryAction && step.actionable ? (
                    <p className="text-sm font-medium text-foreground">
                      Primary action: {step.primaryAction.label}
                    </p>
                  ) : null}
                  {step.blockers[0] && isCurrent && !setupNeeded ? (
                    <p className="text-sm text-destructive">
                      {step.blockers[0].action}
                    </p>
                  ) : step.blockers[0] && isCurrent ? (
                    <p className="text-sm text-muted-foreground">
                      {step.blockers[0].action}
                    </p>
                  ) : null}
                </div>
                {canExpand ? (
                  expanded ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )
                ) : null}
              </button>

              {expanded ? (
                <div
                  className={cn(
                    "border-t border-border p-4",
                    !step.actionable && step.status === "not_started"
                      ? "pointer-events-none opacity-60"
                      : undefined,
                  )}
                >
                  {renderStepContent(step.id)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="text-sm text-muted-foreground">
        {readiness.prohibitedActionsNote}
      </p>
    </div>
  );
}
