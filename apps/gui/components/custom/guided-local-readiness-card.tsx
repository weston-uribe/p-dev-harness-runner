"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { FirstRunReadiness } from "@harness/setup/first-run-readiness";
import type {
  LocalReadinessCheckResult,
  LocalReadinessProgressEvent,
} from "@harness/setup/local-readiness-checks";

import { SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/custom/section-card";
import {
  LocalReadinessChecklist,
  type LocalReadinessUiStatus,
} from "@/components/custom/setup-checklist";
import { LocalReadinessVisualQueue } from "@/lib/local-readiness-visual-queue";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";

interface GuidedLocalReadinessCardProps {
  readiness: FirstRunReadiness;
  onContinue: () => void;
  onStepCompleted?: () => void;
}

interface UiCheckRow {
  id: string;
  label: string;
  status: LocalReadinessUiStatus;
  detail?: string;
  action?: string;
}

function mapCompletedCheck(check: LocalReadinessCheckResult): UiCheckRow {
  return {
    id: check.id,
    label: check.label,
    status: check.status === "passed" ? "passed" : "failed",
    detail: check.detail,
    action: check.action,
  };
}

function parseNdjsonLine(line: string): LocalReadinessProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as LocalReadinessProgressEvent;
  } catch {
    return null;
  }
}

export function GuidedLocalReadinessCard({
  readiness,
  onContinue,
  onStepCompleted,
}: GuidedLocalReadinessCardProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [checks, setChecks] = useState<UiCheckRow[]>([]);
  const [running, setRunning] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const [allPassed, setAllPassed] = useState(false);
  const [stepCompletedEmitted, setStepCompletedEmitted] = useState(false);
  const runGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const visualQueueRef = useRef<LocalReadinessVisualQueue | null>(null);

  const applyCheckUpdate = useCallback((updater: (current: UiCheckRow[]) => UiCheckRow[]) => {
    setChecks(updater);
  }, []);

  const runChecks = useCallback(async () => {
    abortControllerRef.current?.abort();
    visualQueueRef.current?.cancel();

    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setRunning(true);
    setRunError(null);
    setAllPassed(false);
    setStepCompletedEmitted(false);
    setChecks([]);

    const queue = new LocalReadinessVisualQueue((event) => {
      if (runGenerationRef.current !== generation) {
        return;
      }
      if (event.type === "check-started") {
        applyCheckUpdate((current) => {
          if (current.some((row) => row.id === event.id)) {
            return current;
          }
          return [
            ...current,
            {
              id: event.id,
              label: event.label,
              status: "checking",
            },
          ];
        });
        return;
      }
      applyCheckUpdate((current) =>
        current.map((row) =>
          row.id === event.check.id ? mapCompletedCheck(event.check) : row,
        ),
      );
    }, prefersReducedMotion);
    visualQueueRef.current = queue;

    try {
      const response = await fetch("/api/setup/local-readiness?stream=1", {
        signal: abortController.signal,
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Local readiness check failed");
      }
      if (!response.body) {
        throw new Error("Local readiness stream was empty");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (runGenerationRef.current !== generation) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseNdjsonLine(line);
          if (!event || runGenerationRef.current !== generation) {
            continue;
          }
          if (event.type === "run-failed") {
            throw new Error(event.message);
          }
          if (event.type === "run-completed") {
            setAllPassed(event.allPassed);
            continue;
          }
          queue.enqueue(event);
        }
      }

      const trailing = parseNdjsonLine(buffer);
      if (trailing && runGenerationRef.current === generation) {
        if (trailing.type === "run-failed") {
          throw new Error(trailing.message);
        }
        if (trailing.type === "run-completed") {
          setAllPassed(trailing.allPassed);
        } else {
          queue.enqueue(trailing);
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      setRunError(
        error instanceof Error
          ? error.message
          : "Could not run local readiness checks",
      );
      setChecks([]);
      setAllPassed(false);
    } finally {
      if (runGenerationRef.current === generation) {
        setRunning(false);
      }
    }
  }, [applyCheckUpdate, prefersReducedMotion]);

  useEffect(() => {
    void runChecks();
    return () => {
      abortControllerRef.current?.abort();
      visualQueueRef.current?.cancel();
    };
  }, [runChecks]);

  useEffect(() => {
    if (!allPassed || running || stepCompletedEmitted) {
      return;
    }
    onStepCompleted?.();
    setStepCompletedEmitted(true);
  }, [allPassed, onStepCompleted, running, stepCompletedEmitted]);

  const passedChecks = checks.filter((check) => check.status === "passed");

  return (
    <SectionCard
      title={`Step 5 of ${GUIDED_SETUP_STEP_COUNT} · Check local readiness`}
      description="We're checking whether this machine is ready for remote setup."
    >
      <div className={SPACING.stackSm}>
        {running && checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Running local readiness checks…
          </p>
        ) : null}

        {runError ? (
          <div className={SPACING.stackSm}>
            <p className="text-sm text-destructive">{runError}</p>
            <Button type="button" variant="outline" onClick={() => void runChecks()}>
              Retry checks
            </Button>
          </div>
        ) : null}

        {checks.length > 0 ? <LocalReadinessChecklist checks={checks} /> : null}

        {allPassed && !running && !readiness.localReadinessReviewed ? (
          <GuidedStepSuccessPanel
            heading="Local readiness passed"
            explanation="This machine passed the local readiness checks required before cloud secrets setup."
            details={
              passedChecks.length > 0
                ? passedChecks.map((check) => check.label)
                : ["All local readiness checks passed."]
            }
            continueLabel="Continue to cloud secrets"
            onContinue={onContinue}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}
