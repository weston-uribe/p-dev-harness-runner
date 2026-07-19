import type { SkillInclusionMethod } from "../evaluation/contracts/types.js";
import { PHASE_ELIGIBLE_SKILLS } from "../evaluation/telemetry/provenance.js";
import type { PreferredSkillMode, SkillExecutionResult } from "./contracts.js";
import { executeSkillsForPhase } from "../skills/execute.js";

export interface InjectedSkill {
  skillId: string;
  role: string;
  sourcePath: string;
  contentSha256: string;
  skillContractVersion: string | null;
  inclusionMethod: SkillInclusionMethod;
  content: string;
  discovered: boolean | null;
  invoked: boolean | null;
  invocationMode: SkillExecutionResult["invocationMode"];
  evidenceSource: SkillExecutionResult["evidenceSource"];
  fallbackReason?: string;
}

export interface SkillInjectionResult {
  prompt: string;
  skillsUsed: InjectedSkill[];
  skillProvenanceStatus: "present" | "none";
  nativeCapabilityState: string;
  skillResults: SkillExecutionResult[];
}

/**
 * Append canonical skill markdown into a phase prompt as a modular component.
 * Production uses rendered_into_prompt from .agents/skills only.
 * Returns skillsUsed=[] / none when the skill file cannot be loaded.
 */
export async function injectPhaseSkills(params: {
  phase: string;
  basePrompt: string;
  repoRoot?: string;
  preferredMode?: PreferredSkillMode;
}): Promise<SkillInjectionResult> {
  const eligible = PHASE_ELIGIBLE_SKILLS[params.phase] ?? [];
  if (eligible.length === 0) {
    return {
      prompt: params.basePrompt,
      skillsUsed: [],
      skillProvenanceStatus: "none",
      nativeCapabilityState: "unproven",
      skillResults: [],
    };
  }

  const executed = await executeSkillsForPhase({
    requests: eligible.map((item) => ({
      skillId: item.skillId,
      role: item.role,
      sourcePath: item.sourcePath,
    })),
    preferredMode: params.preferredMode ?? "automatic",
    repoRoot: params.repoRoot,
    allowNativeAttempt: false,
  });

  const skillsUsed: InjectedSkill[] = executed.results
    .filter((r) => r.invocationMode === "rendered_into_prompt")
    .map((r) => ({
      skillId: r.skillId,
      role: r.role,
      sourcePath: r.sourcePath,
      contentSha256: r.contentSha256,
      skillContractVersion: null,
      inclusionMethod: r.inclusionMethod,
      content: r.renderedContent ?? "",
      discovered: r.discovered,
      invoked: r.invoked,
      invocationMode: r.invocationMode,
      evidenceSource: r.evidenceSource,
      fallbackReason: r.fallbackReason,
    }));

  if (executed.promptSuffix.length === 0) {
    return {
      prompt: params.basePrompt,
      skillsUsed: [],
      skillProvenanceStatus: "none",
      nativeCapabilityState: executed.nativeCapabilityState,
      skillResults: executed.results,
    };
  }

  return {
    prompt: `${params.basePrompt.trimEnd()}\n${executed.promptSuffix}`,
    skillsUsed,
    skillProvenanceStatus: executed.skillProvenanceStatus,
    nativeCapabilityState: executed.nativeCapabilityState,
    skillResults: executed.results,
  };
}

export function promptNameForPhase(phase: string): string {
  switch (phase) {
    case "planning":
      return "p-dev.planning";
    case "implementation":
      return "p-dev.implementation";
    case "revision":
      return "p-dev.revision";
    case "integration_repair":
      return "p-dev.integration-repair";
    case "plan_review":
      return "p-dev.plan-review";
    case "code_review":
      return "p-dev.code-review";
    case "code_revision":
      return "p-dev.code-revision";
    default:
      return `p-dev.${phase}`;
  }
}
