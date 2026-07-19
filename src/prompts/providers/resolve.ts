import type {
  PreferredSkillMode,
  PromptProviderId,
  PromptResolveResult,
} from "../contracts.js";
import {
  compileTemplate,
  extractVariableNames,
  getRegistryEntryByPhase,
  sha256Text,
} from "../registry.js";
import { injectPhaseSkills } from "../skill-inject.js";
import { createLocalPromptProvider } from "./local.js";
import { createLangfusePromptProvider } from "./langfuse.js";
import {
  assertNotLatestLabel,
  type PromptProviderConfig,
} from "./types.js";

export interface ResolvePhasePromptParams {
  phase: string;
  variables: Record<string, string>;
  /** Already-built local prompt from existing builders — used as authoritative local compile */
  localCompiledPrompt?: string;
  providerConfig?: PromptProviderConfig;
  preferredSkillMode?: PreferredSkillMode;
  repoRoot?: string;
}

function defaultProviderConfig(): PromptProviderConfig {
  const envProvider = process.env.P_DEV_PROMPT_PROVIDER;
  const provider: PromptProviderId =
    envProvider === "langfuse_with_local_fallback"
      ? "langfuse_with_local_fallback"
      : "local";
  const label = process.env.P_DEV_PROMPT_LABEL;
  const versionRaw = process.env.P_DEV_PROMPT_VERSION;
  const version =
    versionRaw != null && versionRaw !== ""
      ? Number.parseInt(versionRaw, 10)
      : undefined;
  return {
    provider,
    ...(label ? { label } : {}),
    ...(version != null && !Number.isNaN(version) ? { version } : {}),
    cacheTtlSeconds: Number.parseInt(
      process.env.P_DEV_PROMPT_CACHE_TTL_SECONDS ?? "60",
      10,
    ),
  };
}

/**
 * Resolve a phase prompt: local is always available; Langfuse is optional with fallback.
 * Production skills remain rendered_into_prompt from .agents/skills.
 */
export async function resolvePhasePrompt(
  params: ResolvePhasePromptParams,
): Promise<PromptResolveResult> {
  const entry = getRegistryEntryByPhase(params.phase);
  if (!entry?.definition.implemented) {
    throw new Error(`No implemented prompt registry entry for phase ${params.phase}`);
  }

  const config = params.providerConfig ?? defaultProviderConfig();
  if (config.label) {
    assertNotLatestLabel(config.label);
  }

  const localProvider = createLocalPromptProvider();
  const localFetch = await localProvider.fetch(entry.definition.name, {
    provider: "local",
  });
  if (!localFetch.ok || !localFetch.template) {
    throw new Error(
      `Local prompt unavailable for ${entry.definition.name}: ${localFetch.errorMessage ?? localFetch.fallbackReason}`,
    );
  }

  const localCompiled =
    params.localCompiledPrompt ??
    compileTemplate(localFetch.template.template, params.variables);

  let source: "local" | "langfuse" = "local";
  let provider: PromptResolveResult["provider"] = "local";
  let providerPromptVersion: number | null = null;
  let providerLabel: string | null = null;
  let providerTemplateSha256: string | null = null;
  let langfusePromptJson: string | null = null;
  let fallbackUsed = false;
  let fallbackReason: PromptResolveResult["fallbackReason"] = "none";
  let compiled = localCompiled;

  if (config.provider === "langfuse_with_local_fallback") {
    const langfuse = createLangfusePromptProvider();
    const remote = await langfuse.fetch(entry.definition.name, config);
    if (remote.ok && remote.template) {
      const remoteVars = extractVariableNames(remote.template.template);
      const missing = remoteVars.filter(
        (v) => params.variables[v] === undefined && !localCompiled.includes(`{{${v}}}`),
      );
      // Validate required names from local schema are present in variables
      const requiredMissing = entry.definition.variableSchema.required.filter(
        (v) => params.variables[v] === undefined,
      );
      if (requiredMissing.length > 0) {
        fallbackUsed = true;
        fallbackReason = "variable_schema_mismatch";
      } else if (missing.length > 0 && params.localCompiledPrompt == null) {
        // When compiling from remote template, all template vars should be provided
        try {
          compiled = compileTemplate(remote.template.template, params.variables);
          source = "langfuse";
          provider = "langfuse_with_local_fallback";
          providerPromptVersion = remote.template.providerVersion;
          providerLabel = remote.template.providerLabel;
          providerTemplateSha256 = remote.template.templateSha256;
          langfusePromptJson = remote.template.langfusePromptJson;
        } catch {
          fallbackUsed = true;
          fallbackReason = "compile_failure";
          compiled = localCompiled;
        }
      } else {
        try {
          compiled = compileTemplate(remote.template.template, params.variables);
          source = "langfuse";
          provider = "langfuse_with_local_fallback";
          providerPromptVersion = remote.template.providerVersion;
          providerLabel = remote.template.providerLabel;
          providerTemplateSha256 = remote.template.templateSha256;
          langfusePromptJson = remote.template.langfusePromptJson;
        } catch {
          fallbackUsed = true;
          fallbackReason = "compile_failure";
          compiled = localCompiled;
        }
      }
    } else {
      fallbackUsed = true;
      fallbackReason = remote.fallbackReason;
      provider = "local_fallback";
      compiled = localCompiled;
    }
  }

  const skillInjection = await injectPhaseSkills({
    phase: params.phase,
    basePrompt: compiled,
    repoRoot: params.repoRoot,
    preferredMode: params.preferredSkillMode ?? "automatic",
  });

  const componentOrdering = [
    "template",
    ...skillInjection.skillResults
      .filter((s) => s.invocationMode !== "none")
      .map((s) => `skill:${s.skillId}`),
  ];

  const skillMode =
    skillInjection.skillResults.find(
      (s) => s.invocationMode === "rendered_into_prompt",
    )?.invocationMode ??
    skillInjection.skillResults[0]?.invocationMode ??
    "none";

  return {
    promptName: entry.definition.name,
    role: entry.definition.role,
    contractVersion: entry.definition.contractVersion,
    provider,
    source,
    providerPromptVersion,
    providerLabel,
    localTemplateSha256: localFetch.template.templateSha256,
    providerTemplateSha256,
    renderedPromptSha256: sha256Text(skillInjection.prompt),
    renderedPrompt: skillInjection.prompt,
    variablesUsed: Object.keys(params.variables).sort(),
    componentOrdering,
    skillInvocationMode: skillMode,
    skillResults: skillInjection.skillResults,
    fallbackUsed,
    fallbackReason,
    langfusePromptJson: source === "langfuse" ? langfusePromptJson : null,
    nativeCapabilityState: skillInjection.nativeCapabilityState as PromptResolveResult["nativeCapabilityState"],
  };
}

export function readPromptProviderFromEnv(): PromptProviderConfig {
  return defaultProviderConfig();
}
