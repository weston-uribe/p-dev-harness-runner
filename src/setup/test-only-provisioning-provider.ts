import type { GitHubHarnessProvisioningProvider } from "./github-remote-provider.js";

const TEST_SEAM_ENV = "HARNESS_VITEST_PROVISIONING_MOCK";

type TestProviderFactory = () => GitHubHarnessProvisioningProvider;

let testProviderFactory: TestProviderFactory | null = null;
let cachedTestProvider: GitHubHarnessProvisioningProvider | null = null;

function isVitestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export function registerHarnessTestProvisioningProviderFactory(
  factory: TestProviderFactory,
): void {
  if (!isVitestRuntime()) {
    throw new Error(
      "Harness test provisioning provider registration is only allowed under vitest.",
    );
  }
  testProviderFactory = factory;
  cachedTestProvider = null;
}

export function clearHarnessTestProvisioningProviderFactory(): void {
  testProviderFactory = null;
  cachedTestProvider = null;
}

/**
 * Returns a mock provisioning provider only when vitest explicitly enables the
 * test seam. Normal packaged runtime cannot activate this path.
 */
export function tryCreateHarnessTestProvisioningProvider(
  env: NodeJS.ProcessEnv = process.env,
): GitHubHarnessProvisioningProvider | null {
  if (!isVitestRuntime()) {
    return null;
  }
  if (env[TEST_SEAM_ENV] !== "enabled") {
    return null;
  }
  if (!testProviderFactory) {
    return null;
  }
  if (!cachedTestProvider) {
    cachedTestProvider = testProviderFactory();
  }
  return cachedTestProvider;
}
