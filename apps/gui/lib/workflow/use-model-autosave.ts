"use client";

import { useCallback } from "react";
import type { RoleModelRole } from "@harness/config/role-models";
import type {
  WorkflowBootstrapPayload,
  WorkflowModelCatalogEntry,
  WorkflowModelSelection,
} from "@harness/workflow-page/types";
import {
  useWorkflowModelSave,
  type WorkflowModelPhaseKey,
} from "@/lib/workflow/use-workflow-model-save";

export type { WorkflowModelPhaseKey, ModelSaveState } from "@/lib/workflow/use-workflow-model-save";

export function resolveModelDisplayName(
  modelCatalog: WorkflowModelCatalogEntry[],
  modelId: string | undefined,
): string {
  if (!modelId) {
    return "Unknown model";
  }
  return (
    modelCatalog.find((model) => model.id === modelId)?.displayName ?? modelId
  );
}

type UseModelAutosaveOptions = {
  bootstrap: WorkflowBootstrapPayload;
  committedSelections: Record<RoleModelRole, WorkflowModelSelection>;
  onCommittedSelectionsChange: (
    role: RoleModelRole,
    selection: WorkflowModelSelection,
  ) => void;
  onBootstrapFingerprintChange: (fingerprint: string) => void;
};

export function useModelAutosave({
  bootstrap,
  committedSelections,
  onCommittedSelectionsChange,
  onBootstrapFingerprintChange,
}: UseModelAutosaveOptions) {
  const {
    optimisticSelections,
    saveErrors,
    handleModelSelect: selectModel,
    handleModelParameter: updateParameter,
    retrySave,
    saveStateLabel,
  } = useWorkflowModelSave({
    context: {
      sourceMode: bootstrap.sourceMode,
      fixtureId: bootstrap.fixtureId,
      selectedScopeId: bootstrap.selectedScopeId,
      configFingerprint: bootstrap.configFingerprint,
    },
    committedSelections,
    onCommittedSelectionChange: onCommittedSelectionsChange,
    onFingerprintChange: onBootstrapFingerprintChange,
  });

  const handleModelSelect = useCallback(
    (phaseKey: WorkflowModelPhaseKey, modelId: string) => {
      selectModel(phaseKey, modelId, bootstrap.modelCatalog);
    },
    [bootstrap.modelCatalog, selectModel],
  );

  const handleModelParameter = useCallback(
    (phaseKey: WorkflowModelPhaseKey, parameterId: string, value: string) => {
      updateParameter(phaseKey, parameterId, value);
    },
    [updateParameter],
  );

  const saveErrorDetail = (phaseKey: WorkflowModelPhaseKey): string | undefined =>
    saveErrors[phaseKey]?.message;

  return {
    plannerSelection: optimisticSelections.planner,
    builderSelection: optimisticSelections.builder,
    planReviewerSelection: optimisticSelections.planReviewer,
    codeReviewerSelection: optimisticSelections.codeReviewer,
    codeReviserSelection: optimisticSelections.codeReviser,
    handleModelSelect,
    handleModelParameter,
    retrySave,
    saveStateLabel,
    saveErrorDetail,
  };
}
