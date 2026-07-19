import { getRegistryEntryByName, sha256Text } from "../registry.js";
import {
  assertNotLatestLabel,
  stripForbiddenRemoteConfig,
  type PromptFetchResult,
  type PromptProvider,
  type PromptProviderConfig,
} from "./types.js";

interface CacheEntry {
  expiresAt: number;
  result: PromptFetchResult;
}

export interface LangfusePromptClientLike {
  prompt: {
    get: (
      name: string,
      options?: {
        version?: number;
        label?: string;
        type?: "text" | "chat";
        cacheTtlSeconds?: number;
      },
    ) => Promise<{
      name: string;
      version: number;
      labels: string[];
      type: "text" | "chat";
      prompt: string | unknown;
      config: unknown;
      isFallback: boolean;
      toJSON: () => string;
    }>;
  };
}

export type LangfuseClientFactory = () => Promise<LangfusePromptClientLike | null>;

const DEFAULT_CACHE_TTL_MS = 60_000;

export class LangfusePromptProvider implements PromptProvider {
  readonly id = "langfuse_with_local_fallback" as const;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly clientFactory: LangfuseClientFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  async fetch(
    name: string,
    config: PromptProviderConfig,
  ): Promise<PromptFetchResult> {
    try {
      assertNotLatestLabel(config.label);
    } catch (err) {
      return {
        ok: false,
        fallbackReason: "latest_forbidden",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (config.label == null && config.version == null) {
      return {
        ok: false,
        fallbackReason: "invalid_label_or_version",
        errorMessage:
          "Langfuse prompt fetch requires an explicit label or version (not latest)",
      };
    }

    const cacheKey = `${name}|${config.label ?? ""}|${config.version ?? ""}`;
    const ttlMs = (config.cacheTtlSeconds ?? 60) * 1000;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.result;
    }

    const entry = getRegistryEntryByName(name);
    if (!entry?.definition.implemented) {
      return {
        ok: false,
        fallbackReason: "contract_mismatch",
        errorMessage: `No local contract for prompt ${name}`,
      };
    }

    let client: LangfusePromptClientLike | null;
    try {
      client = await this.clientFactory();
    } catch (err) {
      return {
        ok: false,
        fallbackReason: "remote_unavailable",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (!client) {
      return {
        ok: false,
        fallbackReason: "provider_disabled",
        errorMessage: "Langfuse prompt client unavailable",
      };
    }

    try {
      const remote = await client.prompt.get(name, {
        ...(config.version != null ? { version: config.version } : {}),
        ...(config.label != null ? { label: config.label } : {}),
        type: "text",
        cacheTtlSeconds: 0,
      });

      if (remote.type !== "text" || typeof remote.prompt !== "string") {
        return {
          ok: false,
          fallbackReason: "type_mismatch",
          errorMessage: `Expected text prompt for ${name}, got ${remote.type}`,
        };
      }

      const remoteConfig = stripForbiddenRemoteConfig(remote.config) as Record<
        string,
        unknown
      > | null;
      const remoteContract =
        typeof remoteConfig?.contractVersion === "string"
          ? remoteConfig.contractVersion
          : typeof remoteConfig?.promptContractVersion === "string"
            ? remoteConfig.promptContractVersion
            : null;

      if (
        remoteContract != null &&
        remoteContract !== entry.definition.contractVersion
      ) {
        return {
          ok: false,
          fallbackReason: "contract_mismatch",
          errorMessage: `Remote contract ${remoteContract} != local ${entry.definition.contractVersion}`,
        };
      }
      if (remoteContract == null) {
        return {
          ok: false,
          fallbackReason: "contract_mismatch",
          errorMessage:
            "Remote prompt must declare config.contractVersion matching the local prompt contract",
        };
      }

      const result: PromptFetchResult = {
        ok: true,
        fallbackReason: "none",
        template: {
          name,
          type: "text",
          template: remote.prompt,
          contractVersion: remoteContract,
          providerVersion: remote.version,
          providerLabel: config.label ?? remote.labels[0] ?? null,
          source: "langfuse",
          templateSha256: sha256Text(remote.prompt),
          langfusePromptJson: remote.toJSON(),
          config: remoteConfig,
        },
      };
      this.cache.set(cacheKey, {
        expiresAt: this.now() + (ttlMs || DEFAULT_CACHE_TTL_MS),
        result,
      });
      return result;
    } catch (err) {
      return {
        ok: false,
        fallbackReason: "remote_unavailable",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function createLangfusePromptProvider(
  factory?: LangfuseClientFactory,
): LangfusePromptProvider {
  return new LangfusePromptProvider(
    factory ??
      (async () => {
        if (process.env.P_DEV_PROMPT_PROVIDER !== "langfuse_with_local_fallback") {
          return null;
        }
        if (
          !process.env.LANGFUSE_PUBLIC_KEY ||
          !process.env.LANGFUSE_SECRET_KEY
        ) {
          return null;
        }
        const mod = await import("@langfuse/client");
        return new mod.LangfuseClient() as unknown as LangfusePromptClientLike;
      }),
  );
}
