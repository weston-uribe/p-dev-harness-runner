import { captureAnalyticsEvent } from "./facade.js";
import type {
  ModelCapabilitySourceProperty,
  ModelConfigurationSurface,
  ParameterEvidenceSourceProperty,
} from "./types.js";

export interface ModelAnalyticsCommon {
  agentRole: string;
  baseModelId: string;
  capabilitySource: ModelCapabilitySourceProperty;
  configurationSurface: ModelConfigurationSurface;
  parameterEvidenceSource: ParameterEvidenceSourceProperty;
}

export function trackFastToggleDisplayed(
  details: ModelAnalyticsCommon,
): void {
  captureAnalyticsEvent({
    type: "p_dev_model_fast_toggle_displayed",
    ...details,
  });
}

export function trackFastPreferenceChanged(
  details: ModelAnalyticsCommon & { fastEnabled: boolean },
): void {
  captureAnalyticsEvent({
    type: "p_dev_model_fast_preference_changed",
    ...details,
  });
}

export function trackModelAgentRunStarted(
  details: ModelAnalyticsCommon & { fastEnabled: boolean },
): void {
  captureAnalyticsEvent({
    type: "p_dev_model_agent_run_started",
    ...details,
  });
}

export function trackModelAgentRunCompleted(
  details: ModelAnalyticsCommon & {
    fastEnabled: boolean;
    outcome: "completed" | "failed";
  },
): void {
  captureAnalyticsEvent({
    type: "p_dev_model_agent_run_completed",
    ...details,
  });
}

export function serializeRequestedModelParams(
  params: Array<{ id: string; value: string }> | null | undefined,
): string {
  const safe = (params ?? [])
    .filter(
      (param) =>
        typeof param.id === "string" &&
        typeof param.value === "string" &&
        param.id.length <= 64 &&
        param.value.length <= 64,
    )
    .map((param) => ({ id: param.id, value: param.value }));
  return JSON.stringify(safe).slice(0, 512);
}
