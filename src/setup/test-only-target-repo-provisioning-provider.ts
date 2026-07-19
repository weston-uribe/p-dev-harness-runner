import type { GitHubTargetRepositoryProvider } from "./github-target-repository-provider.js";

const TEST_SEAM_ENV = "HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK";

type TestProviderFactory = () => GitHubTargetRepositoryProvider;

let testProviderFactory: TestProviderFactory | null = null;
let cachedTestProvider: GitHubTargetRepositoryProvider | null = null;

function isVitestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export function registerTargetRepoTestProvisioningProviderFactory(
  factory: TestProviderFactory,
): void {
  if (!isVitestRuntime()) {
    throw new Error(
      "Target repo test provisioning provider registration is only allowed under vitest.",
    );
  }
  testProviderFactory = factory;
  cachedTestProvider = null;
}

export function clearTargetRepoTestProvisioningProviderFactory(): void {
  testProviderFactory = null;
  cachedTestProvider = null;
}

export function tryCreateTargetRepoTestProvisioningProvider(
  env: NodeJS.ProcessEnv = process.env,
): GitHubTargetRepositoryProvider | null {
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
