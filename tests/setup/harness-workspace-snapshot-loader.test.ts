import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";
import { loadEmbeddedWorkspaceSnapshot } from "../../src/setup/harness-workspace-snapshot-loader.js";
import {
  P_DEV_PACKAGE_ROOT_ENV,
} from "../../src/p-dev/package-paths.js";
import { P_DEV_RUNTIME_MODE_ENV } from "../../src/p-dev/runtime-mode.js";
import {
  createTestWorkspaceSnapshotRoot,
  TEST_SNAPSHOT_SOURCE_COMMIT,
} from "./test-workspace-snapshot-fixture.js";

describe("embedded workspace snapshot loader", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("loads from validated P_DEV_PACKAGE_ROOT when moduleUrl is a nonexistent detached source path", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
    cleanupRoots.push(fixture.packageRoot);

    const bogusModuleUrl = pathToFileURL(
      path.join(
        "/private/tmp/p-dev-v040-candidate-a-e0348f78",
        "src",
        "setup",
        "harness-repo-provisioning.ts",
      ),
    ).href;

    const result = await loadEmbeddedWorkspaceSnapshot(bogusModuleUrl, {
      [P_DEV_RUNTIME_MODE_ENV]: "packaged",
      [P_DEV_PACKAGE_ROOT_ENV]: fixture.packageRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packageRoot).toBe(fixture.packageRoot);
    expect(result.packageVersion).toBe("0.3.1");
    expect(result.manifest.packageVersion).toBe("0.3.1");
    expect(result.manifest.sourceCommit).toBe(TEST_SNAPSHOT_SOURCE_COMMIT);
  });

  it("rejects packaged loading when P_DEV_PACKAGE_ROOT is missing", async () => {
    const result = await loadEmbeddedWorkspaceSnapshot(
      pathToFileURL("/tmp/does-not-matter.js").href,
      {
        [P_DEV_RUNTIME_MODE_ENV]: "packaged",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.state).toBe("snapshot-unavailable");
    expect(result.message).toMatch(/P_DEV_PACKAGE_ROOT is required/);
  });

  it("rejects packaged loading when package.json is missing", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
    cleanupRoots.push(fixture.packageRoot);
    await rm(path.join(fixture.packageRoot, "package.json"), { force: true });

    const result = await loadEmbeddedWorkspaceSnapshot(
      pathToFileURL("/tmp/does-not-matter.js").href,
      {
        [P_DEV_RUNTIME_MODE_ENV]: "packaged",
        [P_DEV_PACKAGE_ROOT_ENV]: fixture.packageRoot,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.state).toBe("snapshot-unavailable");
    expect(result.message).toMatch(/missing package\.json/);
  });

  it("rejects packaged loading when package name is wrong", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
    cleanupRoots.push(fixture.packageRoot);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(fixture.packageRoot, "package.json"),
      JSON.stringify({ name: "wrong-name", version: "0.3.1" }),
      "utf8",
    );

    const result = await loadEmbeddedWorkspaceSnapshot(
      pathToFileURL("/tmp/does-not-matter.js").href,
      {
        [P_DEV_RUNTIME_MODE_ENV]: "packaged",
        [P_DEV_PACKAGE_ROOT_ENV]: fixture.packageRoot,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.state).toBe("snapshot-unavailable");
    expect(result.message).toMatch(/must point to package name p-dev-harness/);
  });

  it("still resolves source-mode snapshots from module URL discovery", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
    cleanupRoots.push(fixture.packageRoot);
    const modulePath = path.join(
      fixture.packageRoot,
      "dist",
      "setup",
      "harness-workspace-snapshot-loader.js",
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "export {}", "utf8");

    const result = await loadEmbeddedWorkspaceSnapshot(
      pathToFileURL(modulePath).href,
      {
        [P_DEV_RUNTIME_MODE_ENV]: "source",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packageRoot).toBe(fixture.packageRoot);
    expect(result.manifest.sourceCommit).toBe(TEST_SNAPSHOT_SOURCE_COMMIT);
  });
});
