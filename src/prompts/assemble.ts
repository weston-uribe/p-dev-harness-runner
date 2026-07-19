/**
 * Phase prompt finalization: local builder output + optional Langfuse override + skills.
 */

import type { PreferredSkillMode, PromptResolveResult } from "./contracts.js";
import { toPromptAssemblyRecord } from "./contracts.js";
import { minimalLangfusePromptLinkJson } from "./langfuse-link.js";
import {
  resolvePhasePrompt,
  type ResolvePhasePromptParams,
} from "./providers/resolve.js";
import type { PromptProviderConfig } from "./providers/types.js";

export interface AssembleAgentPromptParams {
  phase: string;
  /** Variable-substituted local template from builders (no skills yet) */
  localCompiledPrompt: string;
  variables?: Record<string, string>;
  providerConfig?: PromptProviderConfig;
  preferredSkillMode?: PreferredSkillMode;
  repoRoot?: string;
}

export interface AssembledAgentPrompt {
  prompt: string;
  resolve: PromptResolveResult;
  assembly: ReturnType<typeof toPromptAssemblyRecord>;
  /** Minimal name/version/labels JSON for Langfuse linking; null when local */
  langfusePromptLinkJson: string | null;
  skillsUsed: Array<{
    skillId: string;
    sourcePath: string;
    role: string;
    contentSha256: string;
    inclusionMethod: string;
    discovered: boolean | null;
    invoked: boolean | null;
    evidenceSource: string;
    fallbackReason?: string;
  }>;
  skillProvenanceStatus: "present" | "none";
}

export async function assembleAgentPrompt(
  params: AssembleAgentPromptParams,
): Promise<AssembledAgentPrompt> {
  const resolveParams: ResolvePhasePromptParams = {
    phase: params.phase,
    variables: params.variables ?? {},
    localCompiledPrompt: params.localCompiledPrompt,
    providerConfig: params.providerConfig,
    preferredSkillMode: params.preferredSkillMode,
    repoRoot: params.repoRoot,
  };
  const resolve = await resolvePhasePrompt(resolveParams);
  const skillsUsed = resolve.skillResults
    .filter((s) => s.invocationMode === "rendered_into_prompt")
    .map((s) => ({
      skillId: s.skillId,
      sourcePath: s.sourcePath,
      role: s.role,
      contentSha256: s.contentSha256,
      inclusionMethod: s.inclusionMethod,
      discovered: s.discovered,
      invoked: s.invoked,
      evidenceSource: s.evidenceSource,
      fallbackReason: s.fallbackReason,
    }));

  const langfusePromptLinkJson =
    resolve.source === "langfuse"
      ? minimalLangfusePromptLinkJson(resolve.langfusePromptJson, {
          name: resolve.promptName,
          version: resolve.providerPromptVersion,
          label: resolve.providerLabel,
        })
      : null;

  const assembled: AssembledAgentPrompt = {
    prompt: resolve.renderedPrompt,
    resolve,
    assembly: toPromptAssemblyRecord(resolve),
    langfusePromptLinkJson,
    skillsUsed,
    skillProvenanceStatus:
      skillsUsed.length > 0 ? "present" : "none",
  };

  // Consent-gated packaged analytics; no-ops when observability session inactive.
  void import("../observability/prompt-analytics.js")
    .then((m) => m.trackPromptAssemblyAnalytics(assembled))
    .catch(() => undefined);

  return assembled;
}
