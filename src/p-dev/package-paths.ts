import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const P_DEV_PACKAGE_NAME = "p-dev-harness";
export const P_DEV_PACKAGE_ROOT_ENV = "P_DEV_PACKAGE_ROOT";

export function normalizeModuleReferenceToPath(moduleUrl: string): string {
  if (moduleUrl.startsWith("file://")) {
    return fileURLToPath(moduleUrl);
  }
  return path.resolve(moduleUrl);
}

export function resolvePackageRootFromModule(moduleUrl: string): string {
  let current = path.resolve(
    path.dirname(normalizeModuleReferenceToPath(moduleUrl)),
  );

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
        };
        if (parsed.name === P_DEV_PACKAGE_NAME) {
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
    `Could not resolve ${P_DEV_PACKAGE_NAME} package root from ${moduleUrl}.`,
  );
}

export function resolveGuiDirectory(packageRoot: string): string {
  return path.join(packageRoot, "gui");
}

export function resolveTemplatesDirectory(packageRoot: string): string {
  return path.join(packageRoot, "templates");
}

export function resolveWorkspaceSnapshotDirectory(packageRoot: string): string {
  return path.join(packageRoot, "workspace-snapshot");
}

/**
 * Validate an installed npm package root for packaged runtime.
 * Does not use HARNESS_REPO_ROOT (operator workspace).
 */
export function validateInstalledPackageRoot(candidateRoot: string): string {
  const packageRoot = path.resolve(candidateRoot);
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `${P_DEV_PACKAGE_ROOT_ENV} is not a valid ${P_DEV_PACKAGE_NAME} package root (missing package.json): ${packageRoot}`,
    );
  }

  let packageName: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    packageName = parsed.name?.trim();
  } catch {
    throw new Error(
      `${P_DEV_PACKAGE_ROOT_ENV} is not a valid ${P_DEV_PACKAGE_NAME} package root (unreadable package.json): ${packageRoot}`,
    );
  }

  if (packageName !== P_DEV_PACKAGE_NAME) {
    throw new Error(
      `${P_DEV_PACKAGE_ROOT_ENV} must point to package name ${P_DEV_PACKAGE_NAME}, found ${packageName ?? "(missing)"} at ${packageRoot}`,
    );
  }

  const snapshotDirectory = resolveWorkspaceSnapshotDirectory(packageRoot);
  if (
    !existsSync(snapshotDirectory) ||
    !statSync(snapshotDirectory).isDirectory()
  ) {
    throw new Error(
      `${P_DEV_PACKAGE_ROOT_ENV} is missing the workspace-snapshot directory at ${snapshotDirectory}`,
    );
  }

  return packageRoot;
}

/**
 * Resolve the installed package root from P_DEV_PACKAGE_ROOT.
 * Required in packaged runtime; never falls back to import.meta.url walks.
 */
export function resolveInstalledPackageRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[P_DEV_PACKAGE_ROOT_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${P_DEV_PACKAGE_ROOT_ENV} is required in packaged p-dev runtime.`,
    );
  }
  return validateInstalledPackageRoot(raw);
}
