/**
 * Cursor SDK model-parameter propagation contract (Slice D discovery).
 *
 * Proven against @cursor/sdk ModelSelection / AgentOptions:
 * - Agent.create accepts `model: { id, params?: { id, value }[] }`
 * - Parameter ids/values are not hardcoded in the SDK; they come from
 *   Cursor.models.list() → ModelListItem.parameters
 * - reasoningTokens on usage types are telemetry only — not a request control
 *
 * Fail closed:
 * - Do not render or persist a param unless it appears on the capability record
 * - Do not invent allowed values; use capability.allowedValues only
 * - Composer 2.5 fallback currently exposes only `fast` — effort stays hidden
 */

import type { ModelParameterDefinition, ModelParameterValue } from "./types.js";

/** Params the harness may surface in GUI when advertised by capability data. */
export const GUI_RENDERABLE_PARAM_IDS = new Set(["fast", "effort", "reasoning"]);

export function isGuiRenderableModelParam(
  parameter: Pick<ModelParameterDefinition, "id">,
): boolean {
  return GUI_RENDERABLE_PARAM_IDS.has(parameter.id);
}

/**
 * Effort-like enum params: default to medium when supported and unset.
 * Only applies when the capability lists "medium" among allowedValues.
 */
export function defaultEffortValueIfSupported(
  parameter: ModelParameterDefinition,
  stored: ModelParameterValue[] | undefined,
): string | undefined {
  if (parameter.id !== "effort" && parameter.id !== "reasoning") {
    return undefined;
  }
  if (parameter.type !== "enum") {
    return undefined;
  }
  const allowed = parameter.allowedValues ?? [];
  if (!allowed.includes("medium")) {
    return undefined;
  }
  const existing = stored?.find((entry) => entry.id === parameter.id)?.value;
  if (existing && allowed.includes(existing)) {
    return existing;
  }
  return "medium";
}

/** Filter stored params to those advertised by capability (SDK-safe subset). */
export function filterParamsForSdkPropagation(input: {
  supportedParameters: ModelParameterDefinition[];
  requestedParams: ModelParameterValue[];
}): ModelParameterValue[] {
  const allowed = new Map(
    input.supportedParameters.map((parameter) => [parameter.id, parameter]),
  );
  const out: ModelParameterValue[] = [];
  for (const param of input.requestedParams) {
    const definition = allowed.get(param.id);
    if (!definition) continue;
    if (
      definition.type === "enum" &&
      definition.allowedValues &&
      !definition.allowedValues.includes(param.value)
    ) {
      continue;
    }
    if (
      definition.type === "boolean" &&
      param.value !== "true" &&
      param.value !== "false"
    ) {
      continue;
    }
    out.push({ id: param.id, value: param.value });
  }
  return out;
}
