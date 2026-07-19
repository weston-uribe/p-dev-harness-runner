/**
 * Bounded prompt/skill adoption analytics for packaged p-dev.
 * Never includes prompt bodies, skill bodies, or target-repo paths.
 */

import { captureAnalyticsEvent } from "./facade.js";
import type { AssembledAgentPrompt } from "../prompts/assemble.js";

export function trackPromptAssemblyAnalytics(
  assembled: AssembledAgentPrompt,
): void {
  const agentRole = assembled.assembly.role;
  const skillCount = assembled.skillsUsed.length;
  const base = {
    agentRole,
    promptName: assembled.assembly.promptName,
    promptSource: assembled.assembly.source,
    promptContractVersion: assembled.assembly.contractVersion,
    skillInvocationMode: assembled.assembly.skillInvocationMode,
    skillCount,
    nativeCapabilityState: assembled.assembly.nativeCapabilityState,
  };

  try {
    captureAnalyticsEvent({
      type: "p_dev_prompt_resolved",
      ...base,
      remotePromptFallbackUsed: assembled.assembly.fallbackUsed,
    });

    captureAnalyticsEvent({
      type: "p_dev_skill_mode_selected",
      agentRole,
      skillInvocationMode: assembled.assembly.skillInvocationMode,
      skillCount,
      nativeCapabilityState: assembled.assembly.nativeCapabilityState,
    });

    if (assembled.assembly.fallbackUsed) {
      captureAnalyticsEvent({
        type: "p_dev_prompt_fallback_used",
        ...base,
      });
    }

    if (assembled.assembly.nativeCapabilityState !== "supported") {
      captureAnalyticsEvent({
        type: "p_dev_native_skill_unavailable",
        agentRole,
        skillInvocationMode: assembled.assembly.skillInvocationMode,
        nativeCapabilityState: assembled.assembly.nativeCapabilityState,
      });
    }
  } catch {
    // Observability must never break prompt assembly.
  }
}
