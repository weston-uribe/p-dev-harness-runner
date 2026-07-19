import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";

const TEST_SEAM_ENV = "HARNESS_VITEST_REMOTE_SETUP_MOCK";

type TestProviderFactory = () => GitHubRemoteSetupProvider;

let testProviderFactory: TestProviderFactory | null = null;
let cachedTestProvider: GitHubRemoteSetupProvider | null = null;

function isVitestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export function registerHarnessTestRemoteSetupProviderFactory(
  factory: TestProviderFactory,
): void {
  if (!isVitestRuntime()) {
    throw new Error(
      "Harness test remote setup provider registration is only allowed under vitest.",
    );
  }
  testProviderFactory = factory;
  cachedTestProvider = null;
}

export function clearHarnessTestRemoteSetupProviderFactory(): void {
  testProviderFactory = null;
  cachedTestProvider = null;
}

/**
 * Returns a mock remote setup provider only when vitest explicitly enables the
 * test seam. Normal packaged runtime cannot activate this path.
 */
export function tryCreateHarnessTestRemoteSetupProvider(
  env: NodeJS.ProcessEnv = process.env,
): GitHubRemoteSetupProvider | null {
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
