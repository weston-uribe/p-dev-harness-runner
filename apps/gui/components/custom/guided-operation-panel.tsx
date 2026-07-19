"use client";

import { motion, useReducedMotion } from "framer-motion";

export type GuidedOperationPhase = {
  id: string;
  label: string;
  status: "pending" | "active" | "complete";
};

type GuidedOperationPanelProps = {
  phases: GuidedOperationPhase[];
  supportingText?: string | null;
  busy?: boolean;
};

export function GuidedOperationPanel({
  phases,
  supportingText,
  busy = true,
}: GuidedOperationPanelProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const activePhase = phases.find((phase) => phase.status === "active");

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-muted/10 p-4"
      aria-live="polite"
      aria-busy={busy}
      data-testid="guided-operation-panel"
    >
      <ul className="space-y-2">
        {phases.map((phase) => {
          const isActive = phase.status === "active";
          const isComplete = phase.status === "complete";
          return (
            <li
              key={phase.id}
              className="flex items-start gap-2 text-sm"
              data-phase-status={phase.status}
            >
              <span
                className={
                  isComplete
                    ? "mt-0.5 text-emerald-600 dark:text-emerald-400"
                    : isActive
                      ? "mt-0.5 text-foreground"
                      : "mt-0.5 text-muted-foreground"
                }
                aria-hidden="true"
              >
                {isComplete ? "✓" : isActive ? "●" : "○"}
              </span>
              {isActive && !prefersReducedMotion ? (
                <motion.span
                  className="font-medium text-foreground"
                  animate={{ opacity: [0.55, 1, 0.55] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                >
                  {phase.label}
                </motion.span>
              ) : (
                <span
                  className={
                    isActive
                      ? "font-medium text-foreground"
                      : isComplete
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }
                >
                  {phase.label}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {supportingText || activePhase ? (
        <p className="text-sm text-muted-foreground">
          {supportingText ?? activePhase?.label}
        </p>
      ) : null}
    </div>
  );
}

export function buildGuidedOperationPhases(input: {
  labels: string[];
  activeIndex: number;
}): GuidedOperationPhase[] {
  return input.labels.map((label, index) => ({
    id: `phase-${index}`,
    label,
    status:
      index < input.activeIndex
        ? "complete"
        : index === input.activeIndex
          ? "active"
          : "pending",
  }));
}
