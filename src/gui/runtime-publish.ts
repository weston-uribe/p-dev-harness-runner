import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  COMPLETION_MANIFEST_NAME,
  isSafeOperatorRuntimePath,
  isStagingRuntimeDirName,
  P_DEV_DIST_DIR_ENV,
  resolveBuildLockPath,
  resolveCompletionManifestPath,
  resolveFinalRuntimeDir,
  resolveGuiAppDir,
  resolveOperatorRuntimeRoot,
  resolveStagingRuntimeDir,
  toRelativeDistDir,
} from "./runtime-paths.js";
import type { RuntimeSnapshotIdentity } from "./runtime-snapshot.js";
import { isProcessAlive } from "./runtime-registry.js";

export const COMPLETION_MANIFEST_VERSION = 1;
export const BUILD_LOCK_STALE_MS = 30 * 60 * 1000;
export const BUILD_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
export const BUILD_WAIT_POLL_MS = 500;

export interface RuntimeCompletionManifest {
  schemaVersion: number;
  snapshotId: string;
  sourceRoot: string;
  gitHead: string | null;
  contentFingerprint: string;
  buildId: string;
  completedAt: string;
  builderPid: number;
}

export interface BuildLockRecord {
  schemaVersion: number;
  snapshotId: string;
  pid: number;
  stagingDir: string;
  acquiredAt: string;
}

export interface EnsureOperatorRuntimeOptions {
  sourceRoot: string;
  snapshot: RuntimeSnapshotIdentity;
  spawnImpl?: typeof spawn;
  waitTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Unique staging suffix only; lock ownership always uses process.pid. */
  stagingNonce?: number;
}

export interface EnsureOperatorRuntimeResult {
  runtimeDir: string;
  relativeDistDir: string;
  manifest: RuntimeCompletionManifest;
  built: boolean;
  waitedForPeer: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readCompletionManifest(
  runtimeDir: string,
): Promise<RuntimeCompletionManifest | null> {
  try {
    const raw = await readFile(resolveCompletionManifestPath(runtimeDir), "utf8");
    const parsed = JSON.parse(raw) as RuntimeCompletionManifest;
    if (
      parsed.schemaVersion !== COMPLETION_MANIFEST_VERSION ||
      typeof parsed.snapshotId !== "string" ||
      typeof parsed.buildId !== "string" ||
      typeof parsed.contentFingerprint !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function validateStagedRuntime(input: {
  runtimeDir: string;
  snapshot: RuntimeSnapshotIdentity;
}): Promise<{ ok: true; buildId: string } | { ok: false; reason: string }> {
  const { runtimeDir, snapshot } = input;

  if (!(await pathExists(runtimeDir))) {
    return { ok: false, reason: `Runtime directory missing: ${runtimeDir}` };
  }

  const buildIdPath = path.join(runtimeDir, "BUILD_ID");
  let buildId: string;
  try {
    buildId = (await readFile(buildIdPath, "utf8")).trim();
  } catch {
    return { ok: false, reason: `Missing BUILD_ID in ${runtimeDir}` };
  }
  if (!buildId) {
    return { ok: false, reason: `Empty BUILD_ID in ${runtimeDir}` };
  }

  const requiredPaths = [
    path.join(runtimeDir, "build-manifest.json"),
    path.join(runtimeDir, "prerender-manifest.json"),
    path.join(runtimeDir, "routes-manifest.json"),
    path.join(runtimeDir, "static"),
    path.join(runtimeDir, "server"),
  ];

  for (const required of requiredPaths) {
    if (!(await pathExists(required))) {
      return { ok: false, reason: `Missing required build artifact: ${required}` };
    }
  }

  // Prefer app-paths or pages manifest; at least one server entry graph must exist.
  const appPaths = path.join(runtimeDir, "server", "app-paths-manifest.json");
  const pagesPaths = path.join(runtimeDir, "server", "pages-manifest.json");
  if (!(await pathExists(appPaths)) && !(await pathExists(pagesPaths))) {
    return {
      ok: false,
      reason: `Missing server path manifests under ${path.join(runtimeDir, "server")}`,
    };
  }

  const serverDir = path.join(runtimeDir, "server");
  try {
    const serverEntries = await readdir(serverDir);
    if (
      !serverEntries.some(
        (name) =>
          name.endsWith(".js") ||
          name === "app" ||
          name === "chunks" ||
          name === "webpack-runtime.js",
      )
    ) {
      return { ok: false, reason: `Server entrypoints missing under ${serverDir}` };
    }
  } catch {
    return { ok: false, reason: `Cannot read server directory ${serverDir}` };
  }

  const staticDir = path.join(runtimeDir, "static");
  try {
    const staticEntries = await readdir(staticDir);
    if (staticEntries.length === 0) {
      return { ok: false, reason: `Static assets directory empty: ${staticDir}` };
    }
  } catch {
    return { ok: false, reason: `Cannot read static directory ${staticDir}` };
  }

  // Existing completion manifest (if any) must match snapshot.
  const existing = await readCompletionManifest(runtimeDir);
  if (existing) {
    if (
      existing.snapshotId !== snapshot.snapshotId ||
      existing.contentFingerprint !== snapshot.contentFingerprint ||
      path.resolve(existing.sourceRoot) !== path.resolve(snapshot.sourceRoot)
    ) {
      return {
        ok: false,
        reason: "Completion manifest snapshot identity does not match requested snapshot",
      };
    }
  }

  return { ok: true, buildId };
}

export async function isCompletedOperatorRuntime(input: {
  runtimeDir: string;
  snapshot: RuntimeSnapshotIdentity;
}): Promise<boolean> {
  const manifest = await readCompletionManifest(input.runtimeDir);
  if (!manifest) {
    return false;
  }
  if (
    manifest.snapshotId !== input.snapshot.snapshotId ||
    manifest.contentFingerprint !== input.snapshot.contentFingerprint ||
    path.resolve(manifest.sourceRoot) !== path.resolve(input.snapshot.sourceRoot)
  ) {
    return false;
  }
  const validated = await validateStagedRuntime(input);
  return validated.ok;
}

async function writeCompletionManifest(
  runtimeDir: string,
  manifest: RuntimeCompletionManifest,
): Promise<void> {
  const target = resolveCompletionManifestPath(runtimeDir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

async function readBuildLock(
  lockPath: string,
): Promise<BuildLockRecord | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return JSON.parse(raw) as BuildLockRecord;
  } catch {
    return null;
  }
}

async function tryAcquireBuildLock(input: {
  sourceRoot: string;
  snapshotId: string;
  stagingDir: string;
  pid: number;
  now: () => number;
}): Promise<"acquired" | "held"> {
  const lockPath = resolveBuildLockPath(input.sourceRoot, input.snapshotId);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const existing = await readBuildLock(lockPath);
  if (existing) {
    const acquiredAt = Date.parse(existing.acquiredAt);
    const stale =
      !isProcessAlive(existing.pid) ||
      !Number.isFinite(acquiredAt) ||
      input.now() - acquiredAt > BUILD_LOCK_STALE_MS;
    if (!stale) {
      return "held";
    }
    await rm(lockPath, { force: true });
  }

  const record: BuildLockRecord = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    pid: input.pid,
    stagingDir: input.stagingDir,
    acquiredAt: new Date(input.now()).toISOString(),
  };

  try {
    // Exclusive create (O_EXCL / wx) so concurrent launches cannot both build.
    await writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch {
    const again = await readBuildLock(lockPath);
    if (!again) {
      // Lost the create race; do not delete — peer may still be writing.
      return "held";
    }
    if (isProcessAlive(again.pid)) {
      return "held";
    }
    // Stale lock file — remove and retry once.
    await rm(lockPath, { force: true });
    try {
      await writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      return "held";
    }
  }

  const confirmed = await readBuildLock(lockPath);
  if (!confirmed || confirmed.pid !== input.pid) {
    return "held";
  }
  return "acquired";
}

async function releaseBuildLock(input: {
  sourceRoot: string;
  snapshotId: string;
  pid: number;
}): Promise<void> {
  const lockPath = resolveBuildLockPath(input.sourceRoot, input.snapshotId);
  const existing = await readBuildLock(lockPath);
  if (!existing || existing.pid !== input.pid) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function withPreservedGuiTsConfigs<T>(
  sourceRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  const guiDir = resolveGuiAppDir(sourceRoot);
  const tsconfigPath = path.join(guiDir, "tsconfig.json");
  const nextEnvPath = path.join(guiDir, "next-env.d.ts");
  const [tsconfigBefore, nextEnvBefore] = await Promise.all([
    readFile(tsconfigPath, "utf8").catch(() => null),
    readFile(nextEnvPath, "utf8").catch(() => null),
  ]);
  try {
    return await run();
  } finally {
    // Next may rewrite these to point at staging distDir types; restore source defaults.
    if (tsconfigBefore !== null) {
      await writeFile(tsconfigPath, tsconfigBefore, "utf8");
    }
    if (nextEnvBefore !== null) {
      await writeFile(nextEnvPath, nextEnvBefore, "utf8");
    }
  }
}

function runNextBuild(input: {
  sourceRoot: string;
  relativeDistDir: string;
  spawnImpl: typeof spawn;
}): Promise<void> {
  const nextBin = path.join(
    input.sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );

  return withPreservedGuiTsConfigs(input.sourceRoot, () =>
    new Promise((resolve, reject) => {
      const child: ChildProcess = input.spawnImpl(
        nextBin,
        ["build", "apps/gui"],
        {
          cwd: input.sourceRoot,
          stdio: "inherit",
          env: {
            ...process.env,
            [P_DEV_DIST_DIR_ENV]: input.relativeDistDir,
          },
          shell: false,
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`next build failed with exit code ${code ?? "null"}`));
      });
    }),
  );
}

export async function promoteStagedRuntime(input: {
  sourceRoot: string;
  snapshot: RuntimeSnapshotIdentity;
  stagingDir: string;
  buildId: string;
  builderPid: number;
}): Promise<RuntimeCompletionManifest> {
  const finalDir = resolveFinalRuntimeDir(
    input.sourceRoot,
    input.snapshot.snapshotId,
  );

  if (!isSafeOperatorRuntimePath(input.sourceRoot, input.stagingDir)) {
    throw new Error(`Refusing to promote unsafe staging path: ${input.stagingDir}`);
  }
  if (!isSafeOperatorRuntimePath(input.sourceRoot, finalDir)) {
    throw new Error(`Refusing to promote to unsafe final path: ${finalDir}`);
  }

  const manifest: RuntimeCompletionManifest = {
    schemaVersion: COMPLETION_MANIFEST_VERSION,
    snapshotId: input.snapshot.snapshotId,
    sourceRoot: path.resolve(input.snapshot.sourceRoot),
    gitHead: input.snapshot.gitHead,
    contentFingerprint: input.snapshot.contentFingerprint,
    buildId: input.buildId,
    completedAt: new Date().toISOString(),
    builderPid: input.builderPid,
  };

  // Completion manifest is written only after validation, before atomic promote.
  await writeCompletionManifest(input.stagingDir, manifest);

  // If a completed final already exists (race), keep it and drop staging.
  if (await isCompletedOperatorRuntime({
    runtimeDir: finalDir,
    snapshot: input.snapshot,
  })) {
    await rm(input.stagingDir, { recursive: true, force: true });
    const existing = await readCompletionManifest(finalDir);
    if (!existing) {
      throw new Error("Completed runtime disappeared after validation");
    }
    return existing;
  }

  // Replace incomplete final dirs (no valid completion) atomically via swap.
  if (await pathExists(finalDir)) {
    const incomplete = !(await isCompletedOperatorRuntime({
      runtimeDir: finalDir,
      snapshot: input.snapshot,
    }));
    if (incomplete) {
      const junk = `${finalDir}.obsolete-${input.builderPid}`;
      await rename(finalDir, junk);
      await rm(junk, { recursive: true, force: true });
    } else {
      await rm(input.stagingDir, { recursive: true, force: true });
      const existing = await readCompletionManifest(finalDir);
      if (!existing) {
        throw new Error("Completed runtime missing after race");
      }
      return existing;
    }
  }

  await rename(input.stagingDir, finalDir);
  return manifest;
}

export async function cleanupAbandonedStagingDirs(input: {
  sourceRoot: string;
  now?: () => number;
}): Promise<string[]> {
  const root = resolveOperatorRuntimeRoot(input.sourceRoot);
  if (!(await pathExists(root))) {
    return [];
  }

  const removed: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !isStagingRuntimeDirName(entry.name)) {
      continue;
    }
    const stagingDir = path.join(root, entry.name);
    if (!isSafeOperatorRuntimePath(input.sourceRoot, stagingDir)) {
      continue;
    }

    // Parse pid from .building-<snapshot>-<pid>
    const match = /^\.building-.+-(\d+)$/.exec(entry.name);
    const ownerPid = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (Number.isFinite(ownerPid) && isProcessAlive(ownerPid)) {
      continue;
    }

    // Also skip if a live lock still points at this staging dir.
    const snapshotPart = entry.name
      .slice(".building-".length)
      .replace(/-\d+$/, "");
    const lock = await readBuildLock(
      resolveBuildLockPath(input.sourceRoot, snapshotPart),
    );
    if (
      lock &&
      path.resolve(lock.stagingDir) === path.resolve(stagingDir) &&
      isProcessAlive(lock.pid)
    ) {
      continue;
    }

    await rm(stagingDir, { recursive: true, force: true });
    removed.push(stagingDir);
  }
  return removed;
}

export async function deleteOperatorRuntimeDir(input: {
  sourceRoot: string;
  runtimeDir: string;
}): Promise<void> {
  if (!isSafeOperatorRuntimePath(input.sourceRoot, input.runtimeDir)) {
    throw new Error(
      `Refusing to delete path outside operator runtime root: ${input.runtimeDir}`,
    );
  }
  if (isStagingRuntimeDirName(path.basename(input.runtimeDir))) {
    await rm(input.runtimeDir, { recursive: true, force: true });
    return;
  }
  // Only delete completed/final snapshot dirs under the runtime root.
  await rm(input.runtimeDir, { recursive: true, force: true });
}

async function waitForCompletedRuntime(input: {
  sourceRoot: string;
  snapshot: RuntimeSnapshotIdentity;
  timeoutMs: number;
  pollMs: number;
}): Promise<RuntimeCompletionManifest | null> {
  const finalDir = resolveFinalRuntimeDir(
    input.sourceRoot,
    input.snapshot.snapshotId,
  );
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (
      await isCompletedOperatorRuntime({
        runtimeDir: finalDir,
        snapshot: input.snapshot,
      })
    ) {
      return readCompletionManifest(finalDir);
    }
    const lockPath = resolveBuildLockPath(
      input.sourceRoot,
      input.snapshot.snapshotId,
    );
    const lock = await readBuildLock(lockPath);
    if (!lock || !isProcessAlive(lock.pid)) {
      // Builder gone without completion — stop waiting.
      if (
        await isCompletedOperatorRuntime({
          runtimeDir: finalDir,
          snapshot: input.snapshot,
        })
      ) {
        return readCompletionManifest(finalDir);
      }
      return null;
    }
    await sleep(input.pollMs);
  }
  return null;
}

/**
 * Ensure a completed, validated operator runtime exists for the snapshot.
 * Never builds directly into the final reusable directory.
 */
export async function ensureOperatorRuntime(
  options: EnsureOperatorRuntimeOptions,
): Promise<EnsureOperatorRuntimeResult> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const snapshot = options.snapshot;
  const spawnImpl = options.spawnImpl ?? spawn;
  const waitTimeoutMs = options.waitTimeoutMs ?? BUILD_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? BUILD_WAIT_POLL_MS;
  const now = options.now ?? Date.now;
  const lockOwnerPid = process.pid;
  const stagingNonce = options.stagingNonce ?? process.pid;
  const guiAppDir = resolveGuiAppDir(sourceRoot);
  const finalDir = resolveFinalRuntimeDir(sourceRoot, snapshot.snapshotId);

  await mkdir(resolveOperatorRuntimeRoot(sourceRoot), { recursive: true });
  await cleanupAbandonedStagingDirs({ sourceRoot, now });

  if (await isCompletedOperatorRuntime({ runtimeDir: finalDir, snapshot })) {
    const manifest = await readCompletionManifest(finalDir);
    if (!manifest) {
      throw new Error("Completed runtime missing completion manifest");
    }
    return {
      runtimeDir: finalDir,
      relativeDistDir: toRelativeDistDir(guiAppDir, finalDir),
      manifest,
      built: false,
      waitedForPeer: false,
    };
  }

  // Directory without completion manifest is not reusable.
  if (await pathExists(finalDir)) {
    const incomplete = !(await isCompletedOperatorRuntime({
      runtimeDir: finalDir,
      snapshot,
    }));
    if (incomplete) {
      // Do not delete here if a peer might be promoting; only remove when we hold the lock.
    }
  }

  const stagingDir = resolveStagingRuntimeDir(
    sourceRoot,
    snapshot.snapshotId,
    stagingNonce,
  );
  const lockState = await tryAcquireBuildLock({
    sourceRoot,
    snapshotId: snapshot.snapshotId,
    stagingDir,
    pid: lockOwnerPid,
    now,
  });

  if (lockState === "held") {
    const waited = await waitForCompletedRuntime({
      sourceRoot,
      snapshot,
      timeoutMs: waitTimeoutMs,
      pollMs,
    });
    if (!waited) {
      throw new Error(
        `Timed out waiting for peer operator GUI build for snapshot ${snapshot.snapshotId}`,
      );
    }
    return {
      runtimeDir: finalDir,
      relativeDistDir: toRelativeDistDir(guiAppDir, finalDir),
      manifest: waited,
      built: false,
      waitedForPeer: true,
    };
  }

  let built = false;
  try {
    // Preserve any existing completed runtime; only remove incomplete final when we own the lock.
    if (await pathExists(finalDir)) {
      const ok = await isCompletedOperatorRuntime({
        runtimeDir: finalDir,
        snapshot,
      });
      if (ok) {
        const manifest = await readCompletionManifest(finalDir);
        if (!manifest) {
          throw new Error("Completed runtime missing manifest after lock");
        }
        return {
          runtimeDir: finalDir,
          relativeDistDir: toRelativeDistDir(guiAppDir, finalDir),
          manifest,
          built: false,
          waitedForPeer: false,
        };
      }
      // Incomplete final — safe to remove under lock before building a replacement.
      await rm(finalDir, { recursive: true, force: true });
    }

    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    const relativeDistDir = toRelativeDistDir(guiAppDir, stagingDir);
    console.log(
      `Building operator GUI runtime (snapshot ${snapshot.snapshotId}) into staging…`,
    );
    await runNextBuild({
      sourceRoot,
      relativeDistDir,
      spawnImpl,
    });
    built = true;

    const validated = await validateStagedRuntime({
      runtimeDir: stagingDir,
      snapshot,
    });
    if (!validated.ok) {
      throw new Error(`Staged operator runtime failed validation: ${validated.reason}`);
    }

    const manifest = await promoteStagedRuntime({
      sourceRoot,
      snapshot,
      stagingDir,
      buildId: validated.buildId,
      builderPid: lockOwnerPid,
    });

    return {
      runtimeDir: finalDir,
      relativeDistDir: toRelativeDistDir(guiAppDir, finalDir),
      manifest,
      built,
      waitedForPeer: false,
    };
  } catch (error) {
    // Failed build must leave any existing completed runtime untouched (already preserved).
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await releaseBuildLock({
      sourceRoot,
      snapshotId: snapshot.snapshotId,
      pid: lockOwnerPid,
    });
  }
}

export async function assertRuntimeDirIsOperatorOwned(
  sourceRoot: string,
  runtimeDir: string,
): Promise<void> {
  if (!isSafeOperatorRuntimePath(sourceRoot, runtimeDir)) {
    throw new Error(`Unsafe operator runtime path: ${runtimeDir}`);
  }
  const info = await stat(runtimeDir);
  if (!info.isDirectory()) {
    throw new Error(`Operator runtime path is not a directory: ${runtimeDir}`);
  }
  if (path.basename(runtimeDir) === COMPLETION_MANIFEST_NAME) {
    throw new Error("Invalid runtime directory");
  }
}
