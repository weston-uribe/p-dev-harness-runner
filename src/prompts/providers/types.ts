import type {
  PromptFallbackReason,
  PromptProviderId,
  PromptType,
} from "../contracts.js";

export interface PromptProviderConfig {
  provider: PromptProviderId;
  /** Approved label such as dogfood — never "latest" for managed execution */
  label?: string;
  /** Exact numeric version when not using label */
  version?: number;
  cacheTtlSeconds?: number;
}

export interface FetchedPromptTemplate {
  name: string;
  type: PromptType;
  template: string;
  contractVersion: string | null;
  providerVersion: number | null;
  providerLabel: string | null;
  source: "local" | "langfuse";
  templateSha256: string;
  /** Serialized Langfuse prompt client JSON for generation linking; null for local */
  langfusePromptJson: string | null;
  config: unknown;
}

export interface PromptFetchResult {
  ok: boolean;
  template?: FetchedPromptTemplate;
  fallbackReason: PromptFallbackReason;
  errorMessage?: string;
}

export interface PromptProvider {
  readonly id: PromptProviderId;
  fetch(name: string, config: PromptProviderConfig): Promise<PromptFetchResult>;
}

/** Keys that must never be applied from remote prompt config onto harness runtime. */
export const FORBIDDEN_REMOTE_PROMPT_CONFIG_KEYS = [
  "model",
  "modelId",
  "model_id",
  "fast",
  "fastMode",
  "fast_mode",
  "tools",
  "toolPermissions",
  "temperature",
] as const;

export function stripForbiddenRemoteConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of FORBIDDEN_REMOTE_PROMPT_CONFIG_KEYS) {
    delete out[key];
  }
  return out;
}

export function assertNotLatestLabel(label: string | undefined): void {
  if (label != null && label.trim().toLowerCase() === "latest") {
    throw new Error(
      'Managed prompt execution forbids label "latest"; use an explicit approved label or version',
    );
  }
}
