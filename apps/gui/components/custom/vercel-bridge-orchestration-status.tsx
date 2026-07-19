"use client";

import { useEffect, useRef, useState } from "react";

interface VercelBridgeOrchestrationStatusProps {
  message: string;
  phaseLabel?: string;
}

export function VercelBridgeOrchestrationStatus({
  message,
  phaseLabel,
}: VercelBridgeOrchestrationStatusProps) {
  const [announcement, setAnnouncement] = useState(message);
  const previousMessageRef = useRef<string | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (previousMessageRef.current === message) {
      return;
    }
    previousMessageRef.current = message;
    setAnnouncement(message);
  }, [message]);

  return (
    <div
      className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-primary ${
            prefersReducedMotion ? "" : "animate-pulse"
          }`}
        />
        <div className="min-w-0 space-y-1">
          {phaseLabel ? (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {phaseLabel}
            </p>
          ) : null}
          <p
            className={`text-foreground break-words ${
              prefersReducedMotion ? "font-medium" : ""
            }`}
          >
            {message}
          </p>
          <span className="sr-only">{announcement}</span>
        </div>
      </div>
    </div>
  );
}
