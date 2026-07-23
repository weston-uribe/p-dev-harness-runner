import {
  canonicalizeLangfuseEndpoint,
  computeLangfuseProjectScopeDigest,
  CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
  projectReadyDiscoveryConfig,
  type CursorUsageDiscoveryReadyConfig,
  type ResolveCursorUsageDiscoveryConfigResult,
} from "../../../src/evaluation/cursor-usage-import/discovery-config.js";

export function makeReadyDiscoveryConfig(overrides?: {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  namespace?: string;
  environmentFilter?: string | null;
}): CursorUsageDiscoveryReadyConfig {
  const publicKey = overrides?.publicKey ?? "pk-test-cursor-usage";
  const secretKey = overrides?.secretKey ?? "sk-test-cursor-usage";
  const baseUrl = overrides?.baseUrl ?? "http://127.0.0.1:18999";
  const endpoint = canonicalizeLangfuseEndpoint(baseUrl);
  if (!endpoint.ok) {
    throw new Error(endpoint.message);
  }
  return {
    provider: "langfuse",
    publicKey,
    secretKey,
    baseUrl,
    canonicalEndpointIdentity: endpoint.identity,
    langfuseProjectScopeDigest: computeLangfuseProjectScopeDigest({
      canonicalEndpointIdentity: endpoint.identity,
      publicKey,
    }),
    namespace: overrides?.namespace ?? "default",
    environmentFilter:
      overrides && "environmentFilter" in overrides
        ? (overrides.environmentFilter ?? null)
        : null,
    discoveryConfigContractVersion: CURSOR_USAGE_DISCOVERY_CONFIG_CONTRACT_VERSION,
  };
}

export function readyDiscoveryResolver(
  config: CursorUsageDiscoveryReadyConfig = makeReadyDiscoveryConfig(),
): () => ResolveCursorUsageDiscoveryConfigResult {
  return () => ({
    ok: true,
    config,
    publicConfig: projectReadyDiscoveryConfig(config),
  });
}

export function installDiscoveryEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.P_DEV_EVALUATION_PROVIDER = "langfuse";
  env.P_DEV_EVALUATION_NAMESPACE = env.P_DEV_EVALUATION_NAMESPACE || "default";
  env.LANGFUSE_PUBLIC_KEY = env.LANGFUSE_PUBLIC_KEY || "pk-test-cursor-usage";
  env.LANGFUSE_SECRET_KEY = env.LANGFUSE_SECRET_KEY || "sk-test-cursor-usage";
  env.LANGFUSE_BASE_URL = env.LANGFUSE_BASE_URL || "http://127.0.0.1:18999";
}
