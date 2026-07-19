import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessDotenv } from "../config/load-dotenv.js";

const HARNESS_PACKAGE_NAME = "agentic-product-development-harness";
const P_DEV_HOME_ENV = "P_DEV_HOME";

export function resolveHarnessRepoRoot(startDir = process.cwd()): string {
  const fromEnv = process.env.HARNESS_REPO_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  const fromWorkspace = process.env[P_DEV_HOME_ENV]?.trim();
  if (fromWorkspace) {
    return path.resolve(fromWorkspace);
  }

  return resolveHarnessSourceRoot(startDir);
}

/** Workspace for setup files, observability state, and operator-local artifacts. */
export function resolveHarnessWorkspaceDir(startDir = process.cwd()): string {
  const fromWorkspace = process.env[P_DEV_HOME_ENV]?.trim();
  if (fromWorkspace) {
    return path.resolve(fromWorkspace);
  }

  const fromEnv = process.env.HARNESS_REPO_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return resolveHarnessSourceRoot(startDir);
}

export function resolveHarnessSourceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const raw = readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed.name === HARNESS_PACKAGE_NAME) {
          return current;
        }
      } catch {
        // keep walking
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `Could not resolve harness source root from ${startDir}. Set HARNESS_REPO_ROOT or run harness:gui from the repo.`,
  );
}

export function defaultHarnessRepoRootFromModule(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
}

export function normalizeHarnessEnvPaths(cwd: string): void {
  loadHarnessDotenv(cwd);

  const configPath = process.env.HARNESS_CONFIG_PATH?.trim();
  if (configPath && !path.isAbsolute(configPath)) {
    process.env.HARNESS_CONFIG_PATH = path.resolve(cwd, configPath);
  }
}
