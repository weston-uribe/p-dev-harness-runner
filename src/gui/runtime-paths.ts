import path from "node:path";

/** Operator runtimes live under apps/gui/.p-dev-runtime/ (never apps/gui/.next). */
export const OPERATOR_RUNTIME_ROOT_NAME = ".p-dev-runtime";
export const COMPLETION_MANIFEST_NAME = "p-dev-runtime.complete.json";
export const BUILD_LOCK_DIR_NAME = ".locks";
export const STAGING_PREFIX = ".building-";

export const P_DEV_DIST_DIR_ENV = "P_DEV_DIST_DIR";
export const P_DEV_RUNTIME_MODE_ENV = "P_DEV_RUNTIME_MODE";
export const P_DEV_SNAPSHOT_ID_ENV = "P_DEV_SNAPSHOT_ID";
export const P_DEV_BUILD_ID_ENV = "P_DEV_BUILD_ID";

export type GuiRuntimeMode = "operator" | "developer" | "packaged";

export function resolveGuiAppDir(sourceRoot: string): string {
  return path.join(path.resolve(sourceRoot), "apps", "gui");
}

export function resolveOperatorRuntimeRoot(sourceRoot: string): string {
  return path.join(resolveGuiAppDir(sourceRoot), OPERATOR_RUNTIME_ROOT_NAME);
}

export function resolveFinalRuntimeDir(
  sourceRoot: string,
  snapshotId: string,
): string {
  return path.join(resolveOperatorRuntimeRoot(sourceRoot), snapshotId);
}

export function resolveStagingRuntimeDir(
  sourceRoot: string,
  snapshotId: string,
  pid: number,
): string {
  return path.join(
    resolveOperatorRuntimeRoot(sourceRoot),
    `${STAGING_PREFIX}${snapshotId}-${pid}`,
  );
}

export function resolveBuildLockPath(
  sourceRoot: string,
  snapshotId: string,
): string {
  return path.join(
    resolveOperatorRuntimeRoot(sourceRoot),
    BUILD_LOCK_DIR_NAME,
    `${snapshotId}.lock`,
  );
}

export function resolveCompletionManifestPath(runtimeDir: string): string {
  return path.join(runtimeDir, COMPLETION_MANIFEST_NAME);
}

/** distDir value relative to apps/gui for Next.js config. */
export function toRelativeDistDir(guiAppDir: string, absoluteRuntimeDir: string): string {
  const relative = path.relative(path.resolve(guiAppDir), path.resolve(absoluteRuntimeDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Runtime directory ${absoluteRuntimeDir} must be inside GUI app dir ${guiAppDir}`,
    );
  }
  return relative;
}

export function isStagingRuntimeDirName(name: string): boolean {
  return name.startsWith(STAGING_PREFIX);
}

export function isSafeOperatorRuntimePath(
  sourceRoot: string,
  candidate: string,
): boolean {
  const root = resolveOperatorRuntimeRoot(sourceRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}
