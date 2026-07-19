"use client";

import { useCallback, useRef, useState } from "react";
import type { RoleModelRole } from "@harness/config/role-models";
import type { WorkflowModelSelection } from "@harness/workflow-page/types";
import { saveWorkflowModel } from "@/lib/workflow/api-client";

export type WorkflowModelPhaseKey =
  | "planning"
  | "implementation"
  | "plan_review"
  | "code_review"
  | "code_revision";

export type ModelSaveState = "idle" | "saving" | "saved" | "error";

export type ModelSaveError = {
  code?: string;
  message: string;
};

const AUTOSAVE_DELAY_MS = 400;

function phaseToRole(phaseKey: WorkflowModelPhaseKey): RoleModelRole {
  if (phaseKey === "planning") return "planner";
  if (phaseKey === "plan_review") return "planReviewer";
  if (phaseKey === "code_review") return "codeReviewer";
  if (phaseKey === "code_revision") return "codeReviser";
  return "builder";
}

export type WorkflowModelSaveContext = {
  sourceMode: "live" | "fixture";
  fixtureId?: string;
  selectedScopeId?: string;
  configFingerprint: string;
};

export type UseWorkflowModelSaveOptions = {
  context: WorkflowModelSaveContext;
  committedSelections: Record<RoleModelRole, WorkflowModelSelection>;
  onCommittedSelectionChange: (
    role: RoleModelRole,
    selection: WorkflowModelSelection,
  ) => void;
  onFingerprintChange: (fingerprint: string) => void;
};

export function useWorkflowModelSave({
  context,
  committedSelections,
  onCommittedSelectionChange,
  onFingerprintChange,
}: UseWorkflowModelSaveOptions) {
  const [optimisticSelections, setOptimisticSelections] = useState(
    committedSelections,
  );
  const [saveState, setSaveState] = useState<
    Record<WorkflowModelPhaseKey, ModelSaveState>
  >({
    planning: "idle",
    implementation: "idle",
    plan_review: "idle",
    code_review: "idle",
    code_revision: "idle",
  });
  const [saveErrors, setSaveErrors] = useState<
    Partial<Record<WorkflowModelPhaseKey, ModelSaveError>>
  >({});
  const timersRef = useRef<
    Partial<Record<WorkflowModelPhaseKey, ReturnType<typeof setTimeout>>>
  >({});
  const fingerprintRef = useRef(context.configFingerprint);
  const generationRef = useRef<Record<WorkflowModelPhaseKey, number>>({
    planning: 0,
    implementation: 0,
    plan_review: 0,
    code_review: 0,
    code_revision: 0,
  });

  fingerprintRef.current = context.configFingerprint;

  const revertToCommitted = useCallback(
    (phaseKey: WorkflowModelPhaseKey) => {
      const role = phaseToRole(phaseKey);
      const committed = committedSelections[role];
      setOptimisticSelections((current) => ({
        ...current,
        [role]: committed,
      }));
    },
    [committedSelections],
  );

  const runSave = useCallback(
  async (
    phaseKey: WorkflowModelPhaseKey,
    selection: WorkflowModelSelection,
    generation: number,
  ) => {
    const role = phaseToRole(phaseKey);
    try {
      const result = await saveWorkflowModel({
        role,
        modelId: selection.modelId,
        params: selection.parameters,
        expectedConfigFingerprint: fingerprintRef.current,
        sourceMode: context.sourceMode,
        fixtureId: context.fixtureId,
        scopeId: context.selectedScopeId,
        sequenceId: generation,
      });
      if (generation !== generationRef.current[phaseKey]) {
        return;
      }
      fingerprintRef.current = result.configFingerprint;
      onFingerprintChange(result.configFingerprint);
      onCommittedSelectionChange(role, selection);
      setSaveState((current) => ({ ...current, [phaseKey]: "saved" }));
      setSaveErrors((current) => {
        const next = { ...current };
        delete next[phaseKey];
        return next;
      });
    } catch (error) {
      if (generation !== generationRef.current[phaseKey]) {
        return;
      }
      revertToCommitted(phaseKey);
      setSaveState((current) => ({ ...current, [phaseKey]: "error" }));
      const response =
        error instanceof Error && "code" in error
          ? (error as Error & { code?: string })
          : error;
      setSaveErrors((current) => ({
        ...current,
        [phaseKey]: {
          code:
            typeof response === "object" &&
            response &&
            "code" in response &&
            typeof response.code === "string"
              ? response.code
              : undefined,
          message:
            error instanceof Error
              ? error.message
              : "Couldn't save model settings.",
        },
      }));
    }
  },
  [
    context.fixtureId,
    context.selectedScopeId,
    context.sourceMode,
    onCommittedSelectionChange,
    onFingerprintChange,
    revertToCommitted,
  ],
  );

  const scheduleSave = useCallback(
    (phaseKey: WorkflowModelPhaseKey, selection: WorkflowModelSelection) => {
      const existingTimer = timersRef.current[phaseKey];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      setSaveState((current) => ({ ...current, [phaseKey]: "saving" }));
      setSaveErrors((current) => {
        const next = { ...current };
        delete next[phaseKey];
        return next;
      });

      timersRef.current[phaseKey] = setTimeout(() => {
        const generation = generationRef.current[phaseKey] + 1;
        generationRef.current[phaseKey] = generation;
        void runSave(phaseKey, selection, generation);
      }, AUTOSAVE_DELAY_MS);
    },
    [runSave],
  );

  const retrySave = useCallback(
    (phaseKey: WorkflowModelPhaseKey) => {
      const role = phaseToRole(phaseKey);
      const selection = optimisticSelections[role];
      scheduleSave(phaseKey, selection);
    },
    [optimisticSelections, scheduleSave],
  );

  const handleModelSelect = useCallback(
    (
      phaseKey: WorkflowModelPhaseKey,
      modelId: string,
      modelCatalog: Array<{
        id: string;
        displayName?: string;
        supportedParameters: Array<{
          id: string;
          type: string;
          defaultValue?: string;
        }>;
        harnessDefaultParams?: Array<{ id: string; value: string }>;
        fastModeAvailable?: boolean;
      }>,
    ) => {
      const role = phaseToRole(phaseKey);
      const model = modelCatalog.find((entry) => entry.id === modelId);
      // Use PDev harness defaults (Standard), not Cursor provider defaults (may be Fast).
      const defaultParams =
        model?.harnessDefaultParams?.length
          ? model.harnessDefaultParams.map((param) => ({
              id: param.id,
              value: param.value,
            }))
          : (model?.supportedParameters
              .filter((parameter) => parameter.id === "fast")
              .map((parameter) => ({
                id: parameter.id,
                value: "false",
              })) ?? []);
      const fastEnabled = defaultParams.some(
        (param) => param.id === "fast" && param.value === "true",
      );
      const nextSelection: WorkflowModelSelection = {
        modelId,
        displayName: model?.displayName ?? model?.id ?? modelId,
        parameters: defaultParams,
        storedParameters: defaultParams,
        source: "roleModels",
        parameterEvidenceSource: "stored",
        effectiveVariant: model?.fastModeAvailable
          ? fastEnabled
            ? "fast"
            : "standard"
          : "none",
        variantSummary: model?.fastModeAvailable
          ? `${model.displayName ?? modelId} · ${fastEnabled ? "Fast" : "Standard"}`
          : (model?.displayName ?? modelId),
      };
      setOptimisticSelections((current) => ({ ...current, [role]: nextSelection }));
      scheduleSave(phaseKey, nextSelection);
    },
    [scheduleSave],
  );

  const handleModelParameter = useCallback(
    (phaseKey: WorkflowModelPhaseKey, parameterId: string, value: string) => {
      const role = phaseToRole(phaseKey);
      const current = optimisticSelections[role];
      const parameters = [
        ...current.parameters.filter((entry) => entry.id !== parameterId),
        { id: parameterId, value },
      ];
      const fastEnabled = parameters.some(
        (param) => param.id === "fast" && param.value === "true",
      );
      const nextSelection: WorkflowModelSelection = {
        ...current,
        parameters,
        storedParameters: parameters,
        parameterEvidenceSource: "stored",
        effectiveVariant:
          parameterId === "fast" || current.effectiveVariant !== "none"
            ? fastEnabled
              ? "fast"
              : "standard"
            : current.effectiveVariant,
        variantSummary:
          current.displayName &&
          (parameterId === "fast" || current.effectiveVariant !== "none")
            ? `${current.displayName} · ${fastEnabled ? "Fast" : "Standard"}`
            : current.variantSummary,
      };
      setOptimisticSelections((currentState) => ({
        ...currentState,
        [role]: nextSelection,
      }));
      scheduleSave(phaseKey, nextSelection);
    },
    [optimisticSelections, scheduleSave],
  );

  const syncCommittedSelections = useCallback(
    (nextCommitted: Record<RoleModelRole, WorkflowModelSelection>) => {
      setOptimisticSelections(nextCommitted);
    },
    [],
  );

  const saveStateLabel = (phaseKey: WorkflowModelPhaseKey): string | null => {
    switch (saveState[phaseKey]) {
      case "saving":
        return "Saving…";
      case "saved":
        return "Saved";
      case "error":
        return "Couldn't save. Your previous model is still active.";
      default:
        return null;
    }
  };

  return {
    optimisticSelections,
    saveState,
    saveErrors,
    handleModelSelect,
    handleModelParameter,
    retrySave,
    saveStateLabel,
    syncCommittedSelections,
  };
}
