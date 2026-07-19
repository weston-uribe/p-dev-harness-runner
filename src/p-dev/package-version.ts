import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPackagedPDevRuntime } from "./runtime-mode.js";

export const P_DEV_PACKAGE_VERSION_ENV = "P_DEV_PACKAGE_VERSION";

const PACKAGE_JSON_RELATIVE = "../../package.json";
const SEMVER_LIKE_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

export function readHarnessPackageVersion(
  moduleUrl = import.meta.url,
): string {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    PACKAGE_JSON_RELATIVE,
  );
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version?.trim() || "0.0.0";
}

export function readPDevPackageVersionFromPackageRoot(
  packageRoot: string,
): string {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  const version = parsed.version?.trim();
  if (!version || !SEMVER_LIKE_PATTERN.test(version)) {
    throw new Error(
      `Installed p-dev package is missing a valid version in ${packageJsonPath}.`,
    );
  }
  return version;
}

export function validatePackagedRuntimeVersionValue(
  raw: string | undefined,
): string {
  const version = raw?.trim();
  if (!version) {
    throw new Error(
      `${P_DEV_PACKAGE_VERSION_ENV} is required in packaged p-dev runtime.`,
    );
  }
  if (!SEMVER_LIKE_PATTERN.test(version)) {
    throw new Error(
      `${P_DEV_PACKAGE_VERSION_ENV} must be a valid package version string.`,
    );
  }
  return version;
}

export function resolveHarnessPackageVersion(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl = import.meta.url,
): string {
  if (isPackagedPDevRuntime(env)) {
    return validatePackagedRuntimeVersionValue(env[P_DEV_PACKAGE_VERSION_ENV]);
  }
  return readHarnessPackageVersion(moduleUrl);
}
