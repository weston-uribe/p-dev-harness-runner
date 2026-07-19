import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveInstalledPackageRootFromEnv,
  resolvePackageRootFromModule,
  resolveWorkspaceSnapshotDirectory,
} from "../p-dev/package-paths.js";
import { readPDevPackageVersionFromPackageRoot } from "../p-dev/package-version.js";
import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";
import {
  fingerprintWorkspaceSnapshotManifest,
  parseWorkspaceSnapshotManifestJson,
} from "../p-dev/workspace-snapshot-manifest.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import { validateEmbeddedSnapshotFiles } from "../p-dev/workspace-snapshot-validation.js";

export type EmbeddedWorkspaceSnapshotLoadResult =
  | {
      ok: true;
      packageRoot: string;
      snapshotRoot: string;
      packageVersion: string;
      manifest: WorkspaceSnapshotManifest;
      fingerprint: string;
    }
  | { ok: false; state: "snapshot-unavailable" | "snapshot-manifest-missing" | "snapshot-manifest-invalid" | "snapshot-incompatible" | "snapshot-tampered"; message: string };

async function loadEmbeddedWorkspaceSnapshotIdentity(
  moduleUrl: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<EmbeddedWorkspaceSnapshotLoadResult> {
  if (signal?.aborted) {
    return {
      ok: false,
      state: "snapshot-unavailable",
      message: "Embedded workspace snapshot load was aborted.",
    };
  }

  let packageRoot: string;
  try {
    // Packaged Next bundles retain synthetic source-style import.meta.url values.
    // Resolve exclusively from the launcher-validated install root.
    packageRoot = isPackagedPDevRuntime(env)
      ? resolveInstalledPackageRootFromEnv(env)
      : resolvePackageRootFromModule(moduleUrl);
  } catch (error) {
    return {
      ok: false,
      state: "snapshot-unavailable",
      message:
        error instanceof Error
          ? error.message
          : "Could not resolve packaged workspace snapshot root.",
    };
  }

  const snapshotRoot = resolveWorkspaceSnapshotDirectory(packageRoot);
  const manifestPath = path.join(snapshotRoot, "manifest.json");
  let manifestRaw: string;
  try {
    if (signal?.aborted) {
      return {
        ok: false,
        state: "snapshot-unavailable",
        message: "Embedded workspace snapshot load was aborted.",
      };
    }
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch {
    return {
      ok: false,
      state: "snapshot-manifest-missing",
      message: "Embedded workspace snapshot manifest is missing from the package.",
    };
  }

  const parsed = parseWorkspaceSnapshotManifestJson(manifestRaw);
  if (!parsed.ok) {
    return {
      ok: false,
      state: "snapshot-manifest-invalid",
      message: parsed.reason,
    };
  }

  let packageVersion: string;
  try {
    packageVersion = readPDevPackageVersionFromPackageRoot(packageRoot);
  } catch (error) {
    return {
      ok: false,
      state: "snapshot-incompatible",
      message:
        error instanceof Error ? error.message : "Packaged version metadata is invalid.",
    };
  }

  if (parsed.manifest.packageVersion !== packageVersion) {
    return {
      ok: false,
      state: "snapshot-incompatible",
      message: `Embedded snapshot package version ${parsed.manifest.packageVersion} does not match installed package ${packageVersion}.`,
    };
  }

  return {
    ok: true,
    packageRoot,
    snapshotRoot,
    packageVersion,
    manifest: parsed.manifest,
    fingerprint: fingerprintWorkspaceSnapshotManifest(parsed.manifest),
  };
}

/**
 * Status-path identity load: manifest + package version only.
 * Does not re-hash every embedded snapshot file.
 */
export async function loadEmbeddedWorkspaceSnapshotIdentityForStatus(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<EmbeddedWorkspaceSnapshotLoadResult> {
  return loadEmbeddedWorkspaceSnapshotIdentity(moduleUrl, env, signal);
}

export async function loadEmbeddedWorkspaceSnapshot(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddedWorkspaceSnapshotLoadResult> {
  const identity = await loadEmbeddedWorkspaceSnapshotIdentity(moduleUrl, env);
  if (!identity.ok) {
    return identity;
  }

  const embeddedValidation = await validateEmbeddedSnapshotFiles({
    snapshotRoot: identity.snapshotRoot,
    manifest: identity.manifest,
  });
  if (!embeddedValidation.ok) {
    return {
      ok: false,
      state: "snapshot-tampered",
      message: embeddedValidation.reason,
    };
  }

  return identity;
}
