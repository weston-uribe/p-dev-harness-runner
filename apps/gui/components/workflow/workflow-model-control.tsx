"use client";

import { useEffect, useRef } from "react";
import type { WorkflowBootstrapPayload } from "@harness/workflow-page/types";
import { GuidedSelect } from "@/components/ui/guided-select";
import type { WorkflowModelPhaseKey } from "@/lib/workflow/use-model-autosave";
import {
  formatVariantSummary,
  pricingHintForSelection,
  resolveEffectiveVariant,
} from "@/lib/workflow/model-variant-display";

export type WorkflowModelControlProps = {
  label: string;
  phaseKey: WorkflowModelPhaseKey;
  disabled?: boolean;
  modelCatalog: WorkflowBootstrapPayload["modelCatalog"];
  modelId: string;
  parameters: Array<{ id: string; value: string }>;
  saveLabel: string | null;
  saveErrorDetail?: string;
  configurationSurface?: "workflow" | "settings";
  onSelectModel: (phaseKey: WorkflowModelPhaseKey, modelId: string) => void;
  onUpdateModelParameter: (
    phaseKey: WorkflowModelPhaseKey,
    parameterId: string,
    value: string,
  ) => void;
  onRetry?: (phaseKey: WorkflowModelPhaseKey) => void;
  onFastToggleDisplayed?: (details: {
    modelId: string;
    configurationSurface: "workflow" | "settings";
  }) => void;
  onFastPreferenceChanged?: (details: {
    modelId: string;
    fastEnabled: boolean;
    configurationSurface: "workflow" | "settings";
  }) => void;
};

export function WorkflowModelControl({
  label,
  phaseKey,
  disabled = false,
  modelCatalog,
  modelId,
  parameters,
  saveLabel,
  saveErrorDetail,
  configurationSurface = "workflow",
  onSelectModel,
  onUpdateModelParameter,
  onRetry,
  onFastToggleDisplayed,
  onFastPreferenceChanged,
}: WorkflowModelControlProps) {
  const selectedModel = modelCatalog.find((model) => model.id === modelId);
  const showRetry = saveLabel?.startsWith("Couldn't save") && onRetry;
  const fastModeAvailable = Boolean(
    selectedModel?.fastModeAvailable ??
      selectedModel?.supportedParameters.some(
        (parameter) => parameter.id === "fast" && parameter.type === "boolean",
      ),
  );
  const effectiveVariant = resolveEffectiveVariant(parameters, fastModeAvailable);
  const variantSummary = formatVariantSummary(
    selectedModel?.displayName ?? modelId,
    effectiveVariant,
  );
  const pricingHint = pricingHintForSelection(modelId, parameters);
  const displayedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!fastModeAvailable || !onFastToggleDisplayed || !modelId) {
      return;
    }
    const key = `${configurationSurface}:${modelId}`;
    if (displayedKeyRef.current === key) {
      return;
    }
    displayedKeyRef.current = key;
    onFastToggleDisplayed({ modelId, configurationSurface });
  }, [configurationSurface, fastModeAvailable, modelId, onFastToggleDisplayed]);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {saveLabel ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {saveLabel}
          </span>
        ) : null}
      </div>
      {variantSummary ? (
        <p className="text-xs text-muted-foreground" data-testid="model-variant-summary">
          {variantSummary}
        </p>
      ) : null}
      {pricingHint ? (
        <p className="text-xs text-muted-foreground" data-testid="model-pricing-hint">
          {pricingHint}
        </p>
      ) : null}
      {saveErrorDetail ? (
        <p className="text-xs text-muted-foreground">{saveErrorDetail}</p>
      ) : null}
      {showRetry ? (
        <button
          type="button"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => onRetry(phaseKey)}
        >
          Retry
        </button>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Model</span>
        <GuidedSelect
          disabled={disabled}
          value={modelId}
          onChange={(event) => onSelectModel(phaseKey, event.target.value)}
        >
          {modelCatalog
            .filter((model) => model.availability === "available")
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
        </GuidedSelect>
      </label>
      {selectedModel && fastModeAvailable
        ? selectedModel.supportedParameters
            .filter(
              (parameter) =>
                parameter.type === "boolean" && parameter.id === "fast",
            )
            .map((parameter) => {
              const current = parameters.find(
                (entry) => entry.id === parameter.id,
              )?.value;
              const checked = current === "true";
              return (
                <label
                  key={parameter.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>{parameter.label}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={parameter.label}
                    disabled={disabled || !modelId}
                    checked={checked}
                    onChange={(event) => {
                      const nextValue = event.target.checked ? "true" : "false";
                      onFastPreferenceChanged?.({
                        modelId,
                        fastEnabled: event.target.checked,
                        configurationSurface,
                      });
                      onUpdateModelParameter(phaseKey, parameter.id, nextValue);
                    }}
                  />
                </label>
              );
            })
        : null}
      {selectedModel
        ? selectedModel.supportedParameters
            .filter(
              (parameter) =>
                parameter.type === "enum" &&
                (parameter.id === "effort" || parameter.id === "reasoning") &&
                (parameter.allowedValues?.length ?? 0) > 0,
            )
            .map((parameter) => {
              const allowed = parameter.allowedValues ?? [];
              const current =
                parameters.find((entry) => entry.id === parameter.id)?.value ??
                (allowed.includes("medium") ? "medium" : allowed[0]);
              return (
                <label
                  key={parameter.id}
                  className="flex flex-col gap-1 text-sm"
                  data-testid={`model-param-${parameter.id}`}
                >
                  <span className="text-xs text-muted-foreground">
                    {parameter.label}
                  </span>
                  <GuidedSelect
                    disabled={disabled || !modelId}
                    value={current}
                    onChange={(event) =>
                      onUpdateModelParameter(
                        phaseKey,
                        parameter.id,
                        event.target.value,
                      )
                    }
                  >
                    {allowed.map((value) => (
                      <option key={value} value={value}>
                        {value === "extra_high" || value === "xhigh"
                          ? "extra high"
                          : value}
                      </option>
                    ))}
                  </GuidedSelect>
                </label>
              );
            })
        : null}
    </div>
  );
}
