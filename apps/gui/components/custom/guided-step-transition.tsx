"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import type { GuidedTransitionDirection } from "@/lib/guided-setup";
import { cn } from "@/lib/utils";

interface GuidedStepTransitionProps {
  stepKey: string;
  direction: GuidedTransitionDirection;
  children: React.ReactNode;
  className?: string;
  panelRef?: React.RefObject<HTMLElement | null>;
}

function focusIncomingPanel(panel: HTMLElement | null | undefined) {
  if (!panel) {
    return;
  }

  const focusTarget =
    panel.querySelector<HTMLElement>("[data-guided-step-focus]") ??
    panel.querySelector<HTMLElement>("h2, h3, button, a, input, select, textarea");

  focusTarget?.focus({ preventScroll: true });
}

export function GuidedStepTransition({
  stepKey,
  direction,
  children,
  className,
  panelRef,
}: GuidedStepTransitionProps) {
  const prefersReducedMotion = useReducedMotion();
  const pendingFocusTransferRef = useRef(false);
  const previousStepKeyRef = useRef(stepKey);

  useEffect(() => {
    if (previousStepKeyRef.current !== stepKey) {
      pendingFocusTransferRef.current = Boolean(
        panelRef?.current?.contains(document.activeElement),
      );
      previousStepKeyRef.current = stepKey;
    }
  }, [panelRef, stepKey]);

  const spatialDirection =
    direction === "none" ? "forward" : direction;

  const variants = prefersReducedMotion
    ? {
        initial: { opacity: 0 },
        animate: {
          opacity: 1,
          transition: { duration: 0.08, ease: [0.2, 0, 0, 1] as const },
        },
        exit: {
          opacity: 0,
          transition: { duration: 0.08, ease: [0.3, 0, 1, 1] as const },
        },
      }
    : spatialDirection === "forward"
      ? {
          initial: { opacity: 0, x: "100vw" },
          animate: {
            opacity: 1,
            x: 0,
            transition: { duration: 0.32, ease: [0.2, 0, 0, 1] as const },
          },
          exit: {
            opacity: 0,
            x: "-100vw",
            transition: { duration: 0.28, ease: [0.32, 0, 0.67, 0] as const },
          },
        }
      : {
          initial: { opacity: 0, x: "-100vw" },
          animate: {
            opacity: 1,
            x: 0,
            transition: { duration: 0.32, ease: [0.2, 0, 0, 1] as const },
          },
          exit: {
            opacity: 0,
            x: "100vw",
            transition: { duration: 0.28, ease: [0.32, 0, 0.67, 0] as const },
          },
        };

  return (
    <div className="w-full overflow-x-hidden">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={stepKey}
          className={cn(className)}
          variants={variants}
          initial={direction === "none" ? false : "initial"}
          animate="animate"
          exit="exit"
          onAnimationComplete={(definition) => {
            if (definition === "animate" && pendingFocusTransferRef.current) {
              focusIncomingPanel(panelRef?.current ?? null);
              pendingFocusTransferRef.current = false;
            }
          }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
