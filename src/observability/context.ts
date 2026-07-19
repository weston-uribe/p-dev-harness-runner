import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OBSERVABILITY_SCHEMA_VERSION,
  P_DEV_RELEASE_SHA_ENV,
} from "./constants.js";
import type {
  CpuArchFamily,
  ObservabilityContext,
  OsFamily,
  WorkspaceKind,
} from "./types.js";
import { resolveHarnessPackageVersion } from "../p-dev/package-version.js";
import { resolvePackageRootFromModule } from "../p-dev/package-paths.js";

export function resolveOsFamily(platform = process.platform): OsFamily {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "unknown";
}

export function resolveCpuArchFamily(arch: string = process.arch): CpuArchFamily {
  if (arch === "arm64") {
    return "arm64";
  }
  if (arch === "x64") {
    return "x64";
  }
  if (arch) {
    return "other";
  }
  return "unknown";
}

export function resolveNodeMajorVersion(
  version = process.versions.node,
): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function validateReleaseSha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !RELEASE_SHA_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function readReleaseShaFromPackageRoot(packageRoot: string): string {
  const manifestPath = path.join(
    packageRoot,
    "workspace-snapshot",
    "manifest.json",
  );
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { sourceCommit?: string };
    return validateReleaseSha(parsed.sourceCommit) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveReleaseSha(input: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}): string {
  const env = input.env ?? process.env;
  const handoff = validateReleaseSha(env[P_DEV_RELEASE_SHA_ENV]);
  if (handoff) {
    return handoff;
  }

  const moduleUrl = input.moduleUrl ?? import.meta.url;
  try {
    const packageRoot = resolvePackageRootFromModule(moduleUrl);
    const fromManifest = validateReleaseSha(
      readReleaseShaFromPackageRoot(packageRoot),
    );
    if (fromManifest) {
      return fromManifest;
    }
  } catch {
    // fall through to unknown
  }

  return "unknown";
}

export function resolvePackagedReleaseShaFromPackageRoot(
  packageRoot: string,
): string {
  const releaseSha = validateReleaseSha(
    readReleaseShaFromPackageRoot(packageRoot),
  );
  if (!releaseSha) {
    throw new Error(
      "Packaged workspace snapshot manifest is missing a valid sourceCommit.",
    );
  }
  return releaseSha;
}

export interface BuildObservabilityContextInput {
  sessionId: string;
  installationId?: string;
  firstLaunchForPDevHome: boolean;
  workspaceKind?: WorkspaceKind;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function buildObservabilityContext(
  input: BuildObservabilityContextInput,
): ObservabilityContext {
  const env = input.env ?? process.env;
  const moduleUrl = input.moduleUrl ?? import.meta.url;
  let packageVersion: string;

  try {
    packageVersion = resolveHarnessPackageVersion(env, moduleUrl);
  } catch {
    packageVersion = env.P_DEV_PACKAGE_VERSION?.trim() || "0.0.0";
  }

  const releaseSha = resolveReleaseSha({ env, moduleUrl });

  return {
    observabilitySchemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    packageVersion,
    releaseSha,
    runtimeMode: "packaged",
    osFamily: resolveOsFamily(os.platform()),
    cpuArchFamily: resolveCpuArchFamily(os.arch()),
    nodeMajorVersion: resolveNodeMajorVersion(),
    sessionId: input.sessionId,
    installationId: input.installationId,
    firstLaunchForPDevHome: input.firstLaunchForPDevHome,
    workspaceKind: input.workspaceKind ?? "unknown",
  };
}
