import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAbandonedStagingDirs,
  deleteOperatorRuntimeDir,
  ensureOperatorRuntime,
  isCompletedOperatorRuntime,
  promoteStagedRuntime,
  readCompletionManifest,
  validateStagedRuntime,
} from "../../src/gui/runtime-publish.js";
import {
  COMPLETION_MANIFEST_NAME,
  resolveFinalRuntimeDir,
  resolveStagingRuntimeDir,
} from "../../src/gui/runtime-paths.js";
import type { RuntimeSnapshotIdentity } from "../../src/gui/runtime-snapshot.js";

async function makeSourceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "p-dev-runtime-"));
  await mkdir(path.join(root, "apps", "gui"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "agentic-product-development-harness" }),
  );
  return root;
}

function snapshotFor(sourceRoot: string, id = "snapdeadbeef01"): RuntimeSnapshotIdentity {
  return {
    snapshotId: id,
    sourceRoot,
    gitHead: "abc123",
    contentFingerprint: "fingerprint-" + id,
    createdAt: new Date().toISOString(),
  };
}

async function seedMinimalNextBuild(runtimeDir: string): Promise<void> {
  await mkdir(path.join(runtimeDir, "server", "chunks"), { recursive: true });
  await mkdir(path.join(runtimeDir, "static", "chunks"), { recursive: true });
  await writeFile(path.join(runtimeDir, "BUILD_ID"), "build-xyz\n");
  await writeFile(path.join(runtimeDir, "build-manifest.json"), "{}\n");
  await writeFile(path.join(runtimeDir, "prerender-manifest.json"), "{}\n");
  await writeFile(path.join(runtimeDir, "routes-manifest.json"), "{}\n");
  await writeFile(
    path.join(runtimeDir, "server", "app-paths-manifest.json"),
    "{}\n",
  );
  await writeFile(
    path.join(runtimeDir, "server", "webpack-runtime.js"),
    "module.exports={}\n",
  );
  await writeFile(
    path.join(runtimeDir, "static", "chunks", "main.js"),
    "console.log(1)\n",
  );
}

describe("runtime-publish", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats interrupted staged build without completion manifest as not reusable", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const snapshot = snapshotFor(sourceRoot);
    const staging = resolveStagingRuntimeDir(sourceRoot, snapshot.snapshotId, 999001);
    await seedMinimalNextBuild(staging);

    expect(
      await isCompletedOperatorRuntime({
        runtimeDir: staging,
        snapshot,
      }),
    ).toBe(false);

    const finalDir = resolveFinalRuntimeDir(sourceRoot, snapshot.snapshotId);
    await mkdir(finalDir, { recursive: true });
    await seedMinimalNextBuild(finalDir);
    // Directory exists but no completion manifest.
    expect(
      await isCompletedOperatorRuntime({
        runtimeDir: finalDir,
        snapshot,
      }),
    ).toBe(false);
  });

  it("existing directory without completion manifest is not reusable", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const snapshot = snapshotFor(sourceRoot, "snapnoManifest01");
    const finalDir = resolveFinalRuntimeDir(sourceRoot, snapshot.snapshotId);
    await seedMinimalNextBuild(finalDir);
    expect(await readCompletionManifest(finalDir)).toBeNull();
    expect(
      await isCompletedOperatorRuntime({ runtimeDir: finalDir, snapshot }),
    ).toBe(false);
  });

  it("atomic promotion writes completion manifest only after validation", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const snapshot = snapshotFor(sourceRoot, "snappromote0001");
    const staging = resolveStagingRuntimeDir(
      sourceRoot,
      snapshot.snapshotId,
      process.pid,
    );
    await seedMinimalNextBuild(staging);

    const validated = await validateStagedRuntime({
      runtimeDir: staging,
      snapshot,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }

    const manifest = await promoteStagedRuntime({
      sourceRoot,
      snapshot,
      stagingDir: staging,
      buildId: validated.buildId,
      builderPid: process.pid,
    });

    const finalDir = resolveFinalRuntimeDir(sourceRoot, snapshot.snapshotId);
    expect(manifest.snapshotId).toBe(snapshot.snapshotId);
    expect(await readCompletionManifest(finalDir)).toMatchObject({
      snapshotId: snapshot.snapshotId,
      buildId: "build-xyz",
    });
    expect(
      await isCompletedOperatorRuntime({ runtimeDir: finalDir, snapshot }),
    ).toBe(true);
  });

  it("failed build leaves an existing completed active runtime untouched", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const kept = snapshotFor(sourceRoot, "snapotherkeep001");
    const keptStaging = resolveStagingRuntimeDir(
      sourceRoot,
      kept.snapshotId,
      process.pid + 1,
    );
    await seedMinimalNextBuild(keptStaging);
    await promoteStagedRuntime({
      sourceRoot,
      snapshot: kept,
      stagingDir: keptStaging,
      buildId: "build-other",
      builderPid: process.pid + 1,
    });
    const keptFinal = resolveFinalRuntimeDir(sourceRoot, kept.snapshotId);
    const keptBefore = await readFile(
      path.join(keptFinal, COMPLETION_MANIFEST_NAME),
      "utf8",
    );

    const failing = snapshotFor(sourceRoot, "snapfailbuild001");
    const spawnImpl = vi.fn(() => {
      throw new Error("simulated build failure");
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      ensureOperatorRuntime({
        sourceRoot,
        snapshot: failing,
        spawnImpl,
        stagingNonce: process.pid + 42,
      }),
    ).rejects.toThrow(/simulated build failure/);

    expect(
      await readFile(path.join(keptFinal, COMPLETION_MANIFEST_NAME), "utf8"),
    ).toBe(keptBefore);
    expect(
      await isCompletedOperatorRuntime({
        runtimeDir: keptFinal,
        snapshot: kept,
      }),
    ).toBe(true);
  });

  it("two concurrent launches for the same snapshot wait/reuse rather than competing builds", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const snapshot = snapshotFor(sourceRoot, "snapconcurrent01");

    let buildCount = 0;
    const spawnImpl = vi.fn(((_cmd, _args, options) => {
      buildCount += 1;
      const distDir = options?.env?.P_DEV_DIST_DIR as string;
      const absolute = path.join(sourceRoot, "apps", "gui", distDir);
      // Simulate async build.
      const child = {
        once(event: string, cb: (code?: number) => void) {
          if (event === "exit") {
            void seedMinimalNextBuild(absolute).then(() => cb(0));
          }
          return child;
        },
      };
      return child;
    }) as unknown as typeof import("node:child_process").spawn);

    const [first, second] = await Promise.all([
      ensureOperatorRuntime({
        sourceRoot,
        snapshot,
        spawnImpl,
        stagingNonce: 700001,
        pollMs: 20,
        waitTimeoutMs: 10_000,
      }),
      ensureOperatorRuntime({
        sourceRoot,
        snapshot,
        spawnImpl,
        stagingNonce: 700002,
        pollMs: 20,
        waitTimeoutMs: 10_000,
      }),
    ]);

    expect(first.manifest.snapshotId).toBe(snapshot.snapshotId);
    expect(second.manifest.snapshotId).toBe(snapshot.snapshotId);
    expect(buildCount).toBe(1);
    expect(first.waitedForPeer || second.waitedForPeer).toBe(true);
  });

  it("refuses to delete paths outside the operator runtime root", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    await expect(
      deleteOperatorRuntimeDir({
        sourceRoot,
        runtimeDir: path.join(sourceRoot, "apps", "gui", ".next"),
      }),
    ).rejects.toThrow(/outside operator runtime root/);
  });

  it("removes abandoned staging directories only when no live owner", async () => {
    const sourceRoot = await makeSourceRoot();
    cleanups.push(sourceRoot);
    const snapshot = snapshotFor(sourceRoot, "snapabandon0001");
    const deadStaging = resolveStagingRuntimeDir(
      sourceRoot,
      snapshot.snapshotId,
      1,
    );
    await mkdir(deadStaging, { recursive: true });
    await writeFile(path.join(deadStaging, "BUILD_ID"), "x\n");

    const liveStaging = resolveStagingRuntimeDir(
      sourceRoot,
      snapshot.snapshotId,
      process.pid,
    );
    await mkdir(liveStaging, { recursive: true });

    const removed = await cleanupAbandonedStagingDirs({ sourceRoot });
    expect(removed).toContain(deadStaging);
    expect(removed).not.toContain(liveStaging);

    await expect(readFile(path.join(deadStaging, "BUILD_ID"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(liveStaging, ".keep"), "utf8")).rejects.toThrow();
    // live staging directory should still exist
    await writeFile(path.join(liveStaging, "still-here"), "1\n");
    expect(await readFile(path.join(liveStaging, "still-here"), "utf8")).toBe("1\n");
  });
});
