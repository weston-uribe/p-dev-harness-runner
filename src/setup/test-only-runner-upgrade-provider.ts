import type { RunnerUpgradeGitHubProvider } from "./runner-upgrade-provider.js";

const TEST_SEAM_ENV = "HARNESS_VITEST_RUNNER_UPGRADE_MOCK";

type TestProviderFactory = () => RunnerUpgradeGitHubProvider | Promise<RunnerUpgradeGitHubProvider>;

let testProviderFactory: TestProviderFactory | null = null;
let cachedTestProvider: RunnerUpgradeGitHubProvider | null = null;

function isVitestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export function registerHarnessTestRunnerUpgradeProviderFactory(
  factory: TestProviderFactory,
): void {
  if (!isVitestRuntime()) {
    throw new Error(
      "Harness test runner upgrade provider registration is only allowed under vitest.",
    );
  }
  testProviderFactory = factory;
  cachedTestProvider = null;
}

export function clearHarnessTestRunnerUpgradeProviderFactory(): void {
  testProviderFactory = null;
  cachedTestProvider = null;
}

/**
 * Returns a mock runner upgrade provider only when vitest explicitly enables the
 * test seam. Normal packaged runtime cannot activate this path.
 */
export async function tryCreateHarnessTestRunnerUpgradeProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunnerUpgradeGitHubProvider | null> {
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
    cachedTestProvider = await testProviderFactory();
  }
  return cachedTestProvider;
}
