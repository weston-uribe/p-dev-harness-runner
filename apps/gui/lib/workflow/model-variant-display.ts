import type { WorkflowModelCatalogEntry } from "@harness/workflow-page/types";
import {
  formatPricingImpactHint,
  lookupModelPrice,
} from "@harness/evaluation/telemetry/pricing-registry";

export function resolveEffectiveVariant(
  parameters: Array<{ id: string; value: string }>,
  fastModeAvailable: boolean,
): "standard" | "fast" | "none" {
  if (!fastModeAvailable) {
    return "none";
  }
  return parameters.some((param) => param.id === "fast" && param.value === "true")
    ? "fast"
    : "standard";
}

export function formatVariantSummary(
  displayName: string,
  variant: "standard" | "fast" | "none",
): string {
  if (variant === "fast") {
    return `${displayName} · Fast`;
  }
  if (variant === "standard") {
    return `${displayName} · Standard`;
  }
  return displayName;
}

export function pricingHintForSelection(
  modelId: string,
  parameters: Array<{ id: string; value: string }>,
): string | null {
  const entry = lookupModelPrice(modelId, parameters);
  if (!entry) {
    return null;
  }
  return formatPricingImpactHint(entry);
}

export function harnessDefaultParamsForCatalogModel(
  model: WorkflowModelCatalogEntry | undefined,
): Array<{ id: string; value: string }> {
  if (!model) {
    return [];
  }
  if (model.harnessDefaultParams?.length) {
    return model.harnessDefaultParams.map((param) => ({
      id: param.id,
      value: param.value,
    }));
  }
  // Fall back to Standard for boolean Fast when harness defaults missing.
  return model.supportedParameters
    .filter((parameter) => parameter.id === "fast" && parameter.type === "boolean")
    .map((parameter) => ({ id: parameter.id, value: "false" }));
}
