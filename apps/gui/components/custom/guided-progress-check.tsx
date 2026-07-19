"use client";

import { motion, useReducedMotion } from "framer-motion";

interface GuidedProgressCheckProps {
  animateDraw: boolean;
}

export function GuidedProgressCheck({ animateDraw }: GuidedProgressCheckProps) {
  const prefersReducedMotion = useReducedMotion();
  const shouldDraw = animateDraw && !prefersReducedMotion;

  return (
    <svg
      className="size-3.5 sm:size-4"
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
    >
      <motion.path
        d="M3.5 8.5 L6.5 11.5 L12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={shouldDraw ? { pathLength: 0 } : { pathLength: 1 }}
        animate={{ pathLength: 1 }}
        transition={
          shouldDraw
            ? { duration: 0.28, ease: [0.2, 0, 0, 1] as const }
            : { duration: 0 }
        }
      />
    </svg>
  );
}
