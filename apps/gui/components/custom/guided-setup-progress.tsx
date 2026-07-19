"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

import type {
  GuidedProgressStage,
  GuidedProgressStageState,
} from "@/lib/guided-setup";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { GuidedProgressCheck } from "@/components/custom/guided-progress-check";
import { cn } from "@/lib/utils";

type GuidedSetupProgressProps = {
  stages: GuidedProgressStage[];
};

export function GuidedSetupProgress({ stages }: GuidedSetupProgressProps) {
  const prefersReducedMotion = useReducedMotion();
  const priorStatesRef = useRef<Map<string, GuidedProgressStageState>>(new Map());
  const isInitialMountRef = useRef(true);
  const currentStage = stages.find((stage) => stage.state === "current");

  useEffect(() => {
    isInitialMountRef.current = false;
    priorStatesRef.current = new Map(
      stages.map((stage) => [stage.id, stage.state]),
    );
  }, [stages]);

  const shouldAnimateCheck = (stage: GuidedProgressStage): boolean => {
    if (prefersReducedMotion || isInitialMountRef.current) {
      return false;
    }

    const priorState = priorStatesRef.current.get(stage.id);
    return stage.state === "completed" && priorState !== "completed";
  };

  return (
    <nav aria-label="Guided setup progress" className="w-full">
      <ol className="grid grid-cols-7 gap-1 sm:gap-2">
        {stages.map((stage) => {
          const isCurrent = stage.state === "current";
          const isCompleted = stage.state === "completed";
          const srStatus = isCurrent
            ? "current"
            : isCompleted
              ? "completed"
              : "upcoming";

          return (
            <li
              key={stage.id}
              aria-current={isCurrent ? "step" : undefined}
              className="min-w-0"
            >
              <div className="flex flex-col items-center gap-1.5 text-center">
                <motion.div
                  layout={!prefersReducedMotion}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium sm:size-8",
                    isCompleted &&
                      "border-primary bg-primary text-primary-foreground",
                    isCurrent && "border-primary bg-background text-foreground",
                    !isCompleted &&
                      !isCurrent &&
                      "border-border bg-muted text-muted-foreground",
                  )}
                  transition={
                    prefersReducedMotion
                      ? { duration: 0 }
                      : { duration: 0.2, ease: [0.2, 0, 0, 1] }
                  }
                >
                  {isCompleted ? (
                    <GuidedProgressCheck
                      animateDraw={shouldAnimateCheck(stage)}
                    />
                  ) : (
                    <span aria-hidden>{stage.stepNumber}</span>
                  )}
                </motion.div>
                <span
                  className={cn(
                    "hidden w-full truncate text-[10px] font-medium sm:block sm:text-xs",
                    isCurrent
                      ? "text-foreground"
                      : isCompleted
                        ? "text-muted-foreground"
                        : "text-muted-foreground/80",
                  )}
                >
                  {stage.shortLabel}
                </span>
                <span className="sr-only">
                  {`Step ${stage.stepNumber} of ${GUIDED_SETUP_STEP_COUNT}, ${stage.accessibleLabel}, ${srStatus}`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {currentStage ? (
        <p
          aria-live="polite"
          className="mt-3 text-center text-sm font-medium text-foreground sm:hidden"
        >
          {currentStage.shortLabel}
        </p>
      ) : null}
    </nav>
  );
}
