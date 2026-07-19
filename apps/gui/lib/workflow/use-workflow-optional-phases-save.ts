"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodeReviewReadinessView,
  PlanReviewReadinessView,
} from "@harness/workflow-page/types";
import { saveWorkflowOptionalPhases } from "@/lib/workflow/api-client";

export type OptionalPhasesSaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_DELAY_MS = 400;

export type WorkflowOptionalPhasesSaveContext = {
  sourceMode: "live" | "fixture";
  fixtureId?: string;
  selectedScopeId?: string;
  configFingerprint: string;
};

export type OptionalPhasesReadiness = {
  planReview: PlanReviewReadinessView;
  codeReview: CodeReviewReadinessView;
};

function buildSavePayload(readiness: OptionalPhasesReadiness): {
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
} {
  return {
    planReviewEnabled: readiness.planReview.requestedEnabled,
    planReviewCycleLimit: readiness.planReview.cycleLimit,
    codeReviewEnabled: readiness.codeReview.requestedEnabled,
    codeReviewCycleLimit: readiness.codeReview.cycleLimit,
  };
}

export function useWorkflowOptionalPhasesSave({
  context,
  committedReadiness,
  onCommittedReadinessChange,
  onFingerprintChange,
}: {
  context: WorkflowOptionalPhasesSaveContext;
  committedReadiness: OptionalPhasesReadiness;
  onCommittedReadinessChange: (readiness: OptionalPhasesReadiness) => void;
  onFingerprintChange: (fingerprint: string) => void;
}) {
  const [optimisticReadiness, setOptimisticReadiness] =
    useState(committedReadiness);
  const [saveState, setSaveState] = useState<OptionalPhasesSaveState>("idle");
  const [saveError, setSaveError] = useState<string | undefined>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fingerprintRef = useRef(context.configFingerprint);
  const generationRef = useRef(0);

  fingerprintRef.current = context.configFingerprint;

  useEffect(() => {
    setOptimisticReadiness(committedReadiness);
  }, [committedReadiness]);

  const revertToCommitted = useCallback(() => {
    setOptimisticReadiness(committedReadiness);
  }, [committedReadiness]);

  const runSave = useCallback(
    async (readiness: OptionalPhasesReadiness, generation: number) => {
      try {
        const result = await saveWorkflowOptionalPhases({
          ...buildSavePayload(readiness),
          expectedConfigFingerprint: fingerprintRef.current,
          sourceMode: context.sourceMode,
          fixtureId: context.fixtureId,
          scopeId: context.selectedScopeId,
        });
        if (generation !== generationRef.current) {
          return;
        }
        fingerprintRef.current = result.configFingerprint;
        onFingerprintChange(result.configFingerprint);
        onCommittedReadinessChange(readiness);
        setSaveState("saved");
        setSaveError(undefined);
      } catch (error) {
        if (generation !== generationRef.current) {
          return;
        }
        revertToCommitted();
        setSaveState("error");
        setSaveError(
          error instanceof Error
            ? error.message
            : "Couldn't save workflow settings.",
        );
      }
    },
    [
      context.fixtureId,
      context.selectedScopeId,
      context.sourceMode,
      onCommittedReadinessChange,
      onFingerprintChange,
      revertToCommitted,
    ],
  );

  const scheduleSave = useCallback(
    (readiness: OptionalPhasesReadiness) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      setSaveState("saving");
      setSaveError(undefined);
      timerRef.current = setTimeout(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        void runSave(readiness, generation);
      }, AUTOSAVE_DELAY_MS);
    },
    [runSave],
  );

  const handlePlanReviewEnabledChange = useCallback(
    (enabled: boolean) => {
      const committed = committedReadiness.planReview;
      const nextPlan: PlanReviewReadinessView = enabled
        ? {
            ...committed,
            requestedEnabled: true,
            uiState:
              committed.effectiveEnabled &&
              committed.missingRequirementMessages.length === 0
                ? "active"
                : "setup_required",
            effectiveEnabled:
              committed.effectiveEnabled &&
              committed.missingRequirementMessages.length === 0,
          }
        : {
            ...optimisticReadiness.planReview,
            requestedEnabled: false,
            effectiveEnabled: false,
            uiState: "disabled",
            missingRequirementMessages: [
              "Plan Review is disabled in configuration.",
            ],
          };
      const next = {
        ...optimisticReadiness,
        planReview: nextPlan,
      };
      setOptimisticReadiness(next);
      scheduleSave(next);
    },
    [committedReadiness.planReview, optimisticReadiness, scheduleSave],
  );

  const handlePlanReviewCycleLimitChange = useCallback(
    (cycleLimit: number) => {
      const next = {
        ...optimisticReadiness,
        planReview: {
          ...optimisticReadiness.planReview,
          cycleLimit,
        },
      };
      setOptimisticReadiness(next);
      scheduleSave(next);
    },
    [optimisticReadiness, scheduleSave],
  );

  const handleCodeReviewEnabledChange = useCallback(
    (enabled: boolean) => {
      const committed = committedReadiness.codeReview;
      const nextCode: CodeReviewReadinessView = enabled
        ? {
            ...committed,
            requestedEnabled: true,
            uiState:
              committed.effectiveEnabled &&
              committed.missingRequirementMessages.length === 0
                ? "active"
                : "setup_required",
            effectiveEnabled:
              committed.effectiveEnabled &&
              committed.missingRequirementMessages.length === 0,
          }
        : {
            ...optimisticReadiness.codeReview,
            requestedEnabled: false,
            effectiveEnabled: false,
            uiState: "disabled",
            missingRequirementMessages: [
              "Code Review is disabled in configuration.",
            ],
          };
      const next = {
        ...optimisticReadiness,
        codeReview: nextCode,
      };
      setOptimisticReadiness(next);
      scheduleSave(next);
    },
    [committedReadiness.codeReview, optimisticReadiness, scheduleSave],
  );

  const handleCodeReviewCycleLimitChange = useCallback(
    (cycleLimit: number) => {
      const next = {
        ...optimisticReadiness,
        codeReview: {
          ...optimisticReadiness.codeReview,
          cycleLimit,
        },
      };
      setOptimisticReadiness(next);
      scheduleSave(next);
    },
    [optimisticReadiness, scheduleSave],
  );

  const syncCommittedReadiness = useCallback((next: OptionalPhasesReadiness) => {
    setOptimisticReadiness(next);
  }, []);

  const saveStateLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? "Saved"
        : saveState === "error"
          ? "Couldn't save. Your previous settings are still active."
          : null;

  return {
    planReviewReadiness: optimisticReadiness.planReview,
    codeReviewReadiness: optimisticReadiness.codeReview,
    saveStateLabel,
    saveError,
    handlePlanReviewEnabledChange,
    handlePlanReviewCycleLimitChange,
    handleCodeReviewEnabledChange,
    handleCodeReviewCycleLimitChange,
    syncCommittedReadiness,
  };
}
