/**
 * Provider-neutral prompt and skill execution contracts (Chunk 3).
 * Production skill mode remains rendered_into_prompt while native Cloud Agent
 * support is unproven.
 */

import type { SkillInclusionMethod } from "../evaluation/contracts/types.js";

export type PromptProviderId = "local" | "langfuse_with_local_fallback";

export type PromptType = "text" | "chat";

export type PreferredSkillMode =
  | "automatic"
  | "native_when_supported"
  | "rendered_fallback";

export type SkillInvocationMode =
  | "native_cursor_skill"
  | "rendered_into_prompt"
  | "referenced_by_prompt"
  | "none";

export type SkillEvidenceSource =
  | "provider_event"
  | "provider_result"
  | "workspace_contract"
  | "requested_only"
  | "local_render"
  | "none";

/**
 * Native Agent Skill capability for a Cursor execution surface.
 *
 * - supported — direct contract or provider evidence
 * - unsupported — explicit provider/API evidence that the capability is unavailable
 * - unproven — no sufficient evidence either way
 * - unavailable_in_environment — required executable/environment absent; could not be tested
 */
export type NativeSkillCapabilityState =
  | "supported"
  | "unsupported"
  | "unproven"
  | "unavailable_in_environment";

export type CursorExecutionSurface =
  | "cursor_editor"
  | "cursor_cli_interactive"
  | "cursor_cli_non_interactive"
  | "sdk_local_agent"
  | "sdk_cloud_agent"
  | "background_agent";

export interface SkillExecutionRequest {
  skillId: string;
  role: string;
  sourcePath: string;
  contentSha256: string;
  preferredMode: "native" | "rendered_fallback";
}

export interface SkillExecutionResult {
  skillId: string;
  role: string;
  sourcePath: string;
  contentSha256: string;
  requested: boolean;
  /** null = not observed / unproven; never invent true without provider evidence */
  discovered: boolean | null;
  /** null = not observed / unproven; never invent true without provider evidence */
  invoked: boolean | null;
  invocationMode: SkillInvocationMode;
  evidenceSource: SkillEvidenceSource;
  inclusionMethod: SkillInclusionMethod;
  fallbackReason?: string;
  /** Full skill body only when invocationMode is rendered_into_prompt */
  renderedContent?: string;
}

export interface PromptVariableSchema {
  required: string[];
  optional?: string[];
}

export interface PromptDefinition {
  name: string;
  role: string;
  contractVersion: string;
  type: PromptType;
  variableSchema: PromptVariableSchema;
  localTemplatePath: string;
  localTemplateSha256: string;
  /** Reserved slots may exist without a runtime template yet */
  implemented: boolean;
}

export type PromptFallbackReason =
  | "provider_disabled"
  | "remote_unavailable"
  | "contract_mismatch"
  | "variable_schema_mismatch"
  | "type_mismatch"
  | "latest_forbidden"
  | "invalid_label_or_version"
  | "compile_failure"
  | "none";

export interface PromptResolveResult {
  promptName: string;
  role: string;
  contractVersion: string;
  provider: PromptProviderId | "local_fallback";
  source: "local" | "langfuse";
  providerPromptVersion: number | null;
  providerLabel: string | null;
  localTemplateSha256: string;
  providerTemplateSha256: string | null;
  renderedPromptSha256: string;
  renderedPrompt: string;
  variablesUsed: string[];
  componentOrdering: string[];
  skillInvocationMode: SkillInvocationMode;
  skillResults: SkillExecutionResult[];
  fallbackUsed: boolean;
  fallbackReason: PromptFallbackReason;
  /** Present only when a real Langfuse prompt object was the runtime source */
  langfusePromptJson: string | null;
  nativeCapabilityState: NativeSkillCapabilityState;
}

export interface PromptAssemblyRecord {
  promptName: string;
  role: string;
  contractVersion: string;
  provider: PromptResolveResult["provider"];
  source: PromptResolveResult["source"];
  providerPromptVersion: number | null;
  providerLabel: string | null;
  localTemplateSha256: string;
  providerTemplateSha256: string | null;
  renderedPromptSha256: string;
  variablesUsed: string[];
  componentOrdering: string[];
  skillInvocationMode: SkillInvocationMode;
  fallbackUsed: boolean;
  fallbackReason: PromptFallbackReason;
  langfusePromptLinked: boolean;
  nativeCapabilityState: NativeSkillCapabilityState;
  skillIds: string[];
  skillHashes: string[];
}

export function toPromptAssemblyRecord(
  result: PromptResolveResult,
): PromptAssemblyRecord {
  return {
    promptName: result.promptName,
    role: result.role,
    contractVersion: result.contractVersion,
    provider: result.provider,
    source: result.source,
    providerPromptVersion: result.providerPromptVersion,
    providerLabel: result.providerLabel,
    localTemplateSha256: result.localTemplateSha256,
    providerTemplateSha256: result.providerTemplateSha256,
    renderedPromptSha256: result.renderedPromptSha256,
    variablesUsed: result.variablesUsed,
    componentOrdering: result.componentOrdering,
    skillInvocationMode: result.skillInvocationMode,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
    langfusePromptLinked: result.langfusePromptJson != null,
    nativeCapabilityState: result.nativeCapabilityState,
    skillIds: result.skillResults.map((s) => s.skillId),
    skillHashes: result.skillResults.map((s) => s.contentSha256),
  };
}

/** Map SkillInvocationMode onto existing SkillInclusionMethod for telemetry compat */
export function inclusionMethodForInvocation(
  mode: SkillInvocationMode,
): SkillInclusionMethod {
  switch (mode) {
    case "native_cursor_skill":
      return "provider_native";
    case "rendered_into_prompt":
      return "rendered_into_prompt";
    case "referenced_by_prompt":
      return "referenced_by_prompt";
    case "none":
      return "none";
  }
}
