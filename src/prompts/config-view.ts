/**
 * Read-only prompt/skill configuration view for GUI and diagnostics.
 * Does not write config.
 */

import { productionNativeSkillCapability } from "../skills/capability.js";
import type { PreferredSkillMode, PromptProviderId } from "./contracts.js";
import { readPromptProviderFromEnv } from "./providers/resolve.js";

export interface PromptConfigView {
  provider: PromptProviderId;
  label: string | null;
  version: number | null;
  preferredSkillMode: PreferredSkillMode;
  nativeCapabilityState: ReturnType<typeof productionNativeSkillCapability>;
  nativeExecutionAvailable: false;
  notes: string[];
}

export function buildPromptConfigView(params?: {
  provider?: PromptProviderId;
  label?: string | null;
  version?: number | null;
  preferredSkillMode?: PreferredSkillMode;
}): PromptConfigView {
  const env = readPromptProviderFromEnv();
  const nativeCapabilityState = productionNativeSkillCapability();
  return {
    provider: params?.provider ?? env.provider,
    label: params?.label ?? env.label ?? null,
    version: params?.version ?? env.version ?? null,
    preferredSkillMode: params?.preferredSkillMode ?? "automatic",
    nativeCapabilityState,
    nativeExecutionAvailable: false,
    notes: [
      "Local prompt definitions remain the contract authority and guaranteed fallback.",
      "Langfuse prompt provider is optional and never uses label latest for managed execution.",
      "Native Cursor skill execution is unproven for SDK Cloud Agents and is not available in the GUI.",
      "Production skills render from .agents/skills only.",
    ],
  };
}
