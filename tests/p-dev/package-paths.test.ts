import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  P_DEV_PACKAGE_ROOT_ENV,
  resolveGuiDirectory,
  resolveInstalledPackageRootFromEnv,
  resolvePackageRootFromModule,
  resolveTemplatesDirectory,
  resolveWorkspaceSnapshotDirectory,
  validateInstalledPackageRoot,
} from "../../src/p-dev/package-paths.js";

describe("p-dev package paths", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-package-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "p-dev-harness" }),
      "utf8",
    );
    await mkdir(path.join(tempRoot, "workspace-snapshot"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves package, gui, and templates directories from module url", async () => {
    const modulePath = path.join(tempRoot, "dist", "p-dev", "main.js");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "export {}", "utf8");

    const packageRoot = resolvePackageRootFromModule(`file://${modulePath}`);
    expect(packageRoot).toBe(tempRoot);
    expect(resolveGuiDirectory(packageRoot)).toBe(path.join(tempRoot, "gui"));
    expect(resolveTemplatesDirectory(packageRoot)).toBe(
      path.join(tempRoot, "templates"),
    );
    expect(resolveWorkspaceSnapshotDirectory(packageRoot)).toBe(
      path.join(tempRoot, "workspace-snapshot"),
    );
  });

  it("validates an installed package root with snapshot directory", () => {
    expect(validateInstalledPackageRoot(tempRoot)).toBe(tempRoot);
    expect(
      resolveInstalledPackageRootFromEnv({
        [P_DEV_PACKAGE_ROOT_ENV]: tempRoot,
      }),
    ).toBe(tempRoot);
  });

  it("rejects missing P_DEV_PACKAGE_ROOT in packaged env resolution", () => {
    expect(() => resolveInstalledPackageRootFromEnv({})).toThrow(
      /P_DEV_PACKAGE_ROOT is required/,
    );
  });

  it("rejects a directory without package.json", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "p-dev-empty-"));
    try {
      expect(() => validateInstalledPackageRoot(emptyDir)).toThrow(
        /missing package\.json/,
      );
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("rejects a package with the wrong name", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "not-p-dev-harness" }),
      "utf8",
    );
    expect(() => validateInstalledPackageRoot(tempRoot)).toThrow(
      /must point to package name p-dev-harness/,
    );
  });

  it("rejects a package root missing workspace-snapshot", async () => {
    await rm(path.join(tempRoot, "workspace-snapshot"), {
      recursive: true,
      force: true,
    });
    expect(() => validateInstalledPackageRoot(tempRoot)).toThrow(
      /missing the workspace-snapshot directory/,
    );
  });
});
