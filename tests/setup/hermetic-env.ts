/**
 * Hermetic Vitest bootstrap: isolate HOME / TMPDIR, clear inherited live
 * operator config/credentials, and restore harness-critical env keys between
 * tests so ambient machine state cannot silently redirect the suite.
 *
 * P_DEV_HOME is cleared (not forced) so tests that write operator fixtures via
 * HARNESS_REPO_ROOT continue to resolve correctly. Tests that need an explicit
 * operator workspace must set P_DEV_HOME themselves.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

/** Captured before hermetic TMPDIR override so tests can allocate truly external paths. */
export const OS_TMPDIR = (() => {
  try {
    return realpathSync(tmpdir());
  } catch {
    return path.resolve(tmpdir());
  }
})();

export const HARNESS_TEST_ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "P_DEV_HOME",
  "HARNESS_REPO_ROOT",
  "HARNESS_CONFIG_PATH",
  "HARNESS_CONFIG_JSON",
  "HARNESS_CONFIG_JSON_B64",
  "P_DEV_WORKFLOW_STATE_STORE_MODE",
  "P_DEV_RUNTIME_MODE",
  "P_DEV_PACKAGE_VERSION",
  "P_DEV_PACKAGE_ROOT",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_DISPATCH_TOKEN",
  "HARNESS_GITHUB_TOKEN",
  "VERCEL_TOKEN",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_HOST",
  "HARNESS_GUI_PORT",
  "HARNESS_GUI_HOST",
  "HARNESS_VITEST_PROVISIONING_MOCK",
  "HARNESS_VITEST_REMOTE_SETUP_MOCK",
  "HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK",
  "HARNESS_VITEST_RUNNER_UPGRADE_MOCK",
] as const;

export type HarnessTestEnvKey = (typeof HARNESS_TEST_ENV_KEYS)[number];

type EnvSnapshot = Map<string, string | undefined>;

let workerHome: string | undefined;
let workerTmp: string | undefined;
let baselineSnapshot: EnvSnapshot | undefined;
const initialCwd = process.cwd();

function snapshotKeys(keys: readonly string[]): EnvSnapshot {
  const snap: EnvSnapshot = new Map();
  for (const key of keys) {
    snap.set(key, process.env[key]);
  }
  return snap;
}

function restoreKeys(snap: EnvSnapshot): void {
  for (const [key, value] of snap) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Clear inherited live config paths that point outside the hermetic worker tree.
 * Returns the cleared path when one was removed.
 */
export function clearInheritedLiveConfigPath(workerRoot: string): string | undefined {
  const raw = process.env.HARNESS_CONFIG_PATH?.trim();
  if (!raw) {
    return undefined;
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
  const root = path.resolve(workerRoot);
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return undefined;
  }
  delete process.env.HARNESS_CONFIG_PATH;
  return resolved;
}

/**
 * Apply a temporary env overlay for one callback, then restore the previous values.
 */
export async function withTestEnv<T>(
  vars: Partial<Record<string, string | undefined>>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const keys = Object.keys(vars);
  const previous = snapshotKeys(keys);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    restoreKeys(previous);
  }
}

export function getHermeticWorkerPaths(): {
  home: string;
  tmp: string;
  /** Reserved workspace directory under HOME; not auto-exported as P_DEV_HOME. */
  pDevHome: string;
} {
  if (!workerHome || !workerTmp) {
    throw new Error("Hermetic worker paths are not initialized");
  }
  return {
    home: workerHome,
    tmp: workerTmp,
    pDevHome: path.join(workerHome, "workspace"),
  };
}

beforeAll(() => {
  if (process.env.P_DEV_TEST_ALLOW_REAL_HOME === "1") {
    baselineSnapshot = snapshotKeys(HARNESS_TEST_ENV_KEYS);
    return;
  }

  workerHome = realpathSync(mkdtempSync(path.join(OS_TMPDIR, "p-dev-test-home-")));
  workerTmp = path.join(workerHome, "tmp");
  const workerPDevHome = path.join(workerHome, "workspace");
  mkdirSync(workerTmp, { recursive: true });
  mkdirSync(workerPDevHome, { recursive: true });

  process.env.HOME = workerHome;
  process.env.TMPDIR = workerTmp;
  process.env.TMP = workerTmp;
  process.env.TEMP = workerTmp;

  // Clear inherited operator workspace — do not force a fake P_DEV_HOME so
  // HARNESS_REPO_ROOT / source-root resolution remains available to tests.
  delete process.env.P_DEV_HOME;

  clearInheritedLiveConfigPath(workerHome);

  for (const key of HARNESS_TEST_ENV_KEYS) {
    if (
      key === "HOME" ||
      key === "TMPDIR" ||
      key === "TMP" ||
      key === "TEMP"
    ) {
      continue;
    }
    delete process.env[key];
  }

  baselineSnapshot = snapshotKeys(HARNESS_TEST_ENV_KEYS);
});

beforeEach(() => {
  if (!baselineSnapshot) {
    return;
  }
  restoreKeys(baselineSnapshot);
  if (workerHome) {
    clearInheritedLiveConfigPath(workerHome);
  }
});

afterEach(() => {
  if (baselineSnapshot) {
    restoreKeys(baselineSnapshot);
  }
  // Do not call vi.unstubAllGlobals() here — module-scoped fetch stubs (e.g.
  // vercel client tests) must remain installed for the worker lifetime.
  if (process.cwd() !== initialCwd) {
    process.chdir(initialCwd);
  }
});

afterAll(() => {
  if (process.env.P_DEV_TEST_ALLOW_REAL_HOME === "1") {
    return;
  }
  if (workerHome) {
    rmSync(workerHome, { recursive: true, force: true });
  }
});
