import type { ModelSelection } from "@cursor/sdk";
import { resolveCapabilityForModelId } from "./capabilities.js";
import type { ModelCapabilityRecord, ModelParameterValue } from "./types.js";

export class ModelParameterValidationError extends Error {
  readonly code = "model_parameter_rejected" as const;
  readonly modelId: string;
  readonly parameterId: string;
  readonly parameterValue: string;
  readonly failureClassification: string;

  constructor(input: {
    modelId: string;
    parameterId: string;
    parameterValue: string;
    message?: string;
    failureClassification?: string;
  }) {
    super(
      input.message ??
        `Model parameter rejected for ${input.modelId}: ${input.parameterId}=${input.parameterValue}`,
    );
    this.name = "ModelParameterValidationError";
    this.modelId = input.modelId;
    this.parameterId = input.parameterId;
    this.parameterValue = input.parameterValue;
    this.failureClassification =
      input.failureClassification ?? "model_parameter_rejected";
  }
}

/**
 * Validate a ModelSelection against capabilities before Agent.create.
 * Fails closed — never silently drops or substitutes a more expensive variant.
 */
export function assertModelSelectionAccepted(input: {
  selection: ModelSelection;
  catalog?: ModelCapabilityRecord[];
}): void {
  const { selection } = input;
  const capability = resolveCapabilityForModelId(
    selection.id,
    input.catalog ?? [],
  );
  const params = selection.params ?? [];

  for (const param of params) {
    const definition = capability.supportedParameters.find(
      (entry) => entry.id === param.id,
    );
    if (!definition) {
      // Unknown params: allow only if capability catalog is empty (unknown model).
      if (capability.supportedParameters.length > 0) {
        throw new ModelParameterValidationError({
          modelId: selection.id,
          parameterId: param.id,
          parameterValue: param.value,
          message: `Unsupported parameter "${param.id}" for model ${selection.id}`,
          failureClassification: "unsupported_model_parameter",
        });
      }
      continue;
    }
    if (
      definition.allowedValues &&
      definition.allowedValues.length > 0 &&
      !definition.allowedValues.includes(param.value)
    ) {
      throw new ModelParameterValidationError({
        modelId: selection.id,
        parameterId: param.id,
        parameterValue: param.value,
        message: `Invalid value "${param.value}" for parameter "${param.id}" on model ${selection.id}`,
        failureClassification: "invalid_model_parameter_value",
      });
    }
  }

  if (capability.fastModeAvailable) {
    const fast = params.find((param) => param.id === "fast");
    if (!fast) {
      throw new ModelParameterValidationError({
        modelId: selection.id,
        parameterId: "fast",
        parameterValue: "",
        message: `Missing explicit fast parameter for model ${selection.id}; refusing Cursor omission default`,
        failureClassification: "missing_required_model_parameter",
      });
    }
  }
}

export function classifyProviderModelError(
  error: unknown,
  selection: ModelSelection,
): ModelParameterValidationError | null {
  if (error instanceof ModelParameterValidationError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    !/model|parameter|param|fast|unsupported|invalid|reject/i.test(lower)
  ) {
    return null;
  }
  const params = selection.params ?? [];
  const fast = params.find((param) => param.id === "fast");
  return new ModelParameterValidationError({
    modelId: selection.id,
    parameterId: fast?.id ?? params[0]?.id ?? "unknown",
    parameterValue: fast?.value ?? params[0]?.value ?? "",
    message: `Provider rejected model selection for ${selection.id}: ${message}`,
    failureClassification: "provider_model_parameter_rejected",
  });
}

export function selectionParams(
  selection: ModelSelection,
): ModelParameterValue[] {
  return (selection.params ?? []).map((param) => ({
    id: param.id,
    value: param.value,
  }));
}
