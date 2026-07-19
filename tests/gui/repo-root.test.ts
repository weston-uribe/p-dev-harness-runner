import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeHarnessEnvPaths,
  resolveHarnessRepoRoot,
  resolveHarnessSourceRoot,
  resolveHarnessWorkspaceDir,
} from "../../src/gui/repo-root.js";

describe("resolveHarnessRepoRoot", () => {
  let tempRoot = "";

  beforeEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-repo-root-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    const guiDir = path.join(tempRoot, "apps", "gui");
    await mkdir(guiDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("walks up from apps/gui to the harness repo root", () => {
    const guiDir = path.join(tempRoot, "apps", "gui");
    expect(resolveHarnessRepoRoot(guiDir)).toBe(tempRoot);
  });

  it("prefers HARNESS_REPO_ROOT when set", () => {
    const otherRoot = path.join(tempRoot, "custom-root");
    process.env.HARNESS_REPO_ROOT = otherRoot;
    expect(resolveHarnessRepoRoot(path.join(tempRoot, "apps", "gui"))).toBe(
      otherRoot,
    );
  });

  it("uses P_DEV_HOME when HARNESS_REPO_ROOT is unset", () => {
    const workspaceRoot = path.join(tempRoot, "operator-workspace");
    process.env.P_DEV_HOME = workspaceRoot;
    expect(resolveHarnessRepoRoot(path.join(tempRoot, "apps", "gui"))).toBe(
      workspaceRoot,
    );
  });

  it("resolves relative HARNESS_CONFIG_PATH against repo root", async () => {
    await writeFile(path.join(tempRoot, ".env.local"), "HARNESS_CONFIG_PATH=.harness/config.local.json\n", "utf8");
    normalizeHarnessEnvPaths(tempRoot);
    expect(process.env.HARNESS_CONFIG_PATH).toBe(
      path.join(tempRoot, ".harness/config.local.json"),
    );
  });
});

describe("resolveHarnessWorkspaceDir", () => {
  let tempRoot = "";

  beforeEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-workspace-root-"));
  });

  afterEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prefers P_DEV_HOME over HARNESS_REPO_ROOT for operator workspace reads", () => {
    const workspaceRoot = path.join(tempRoot, "operator-workspace");
    const sourceRoot = path.join(tempRoot, "source-root");
    process.env.P_DEV_HOME = workspaceRoot;
    process.env.HARNESS_REPO_ROOT = sourceRoot;
    expect(resolveHarnessWorkspaceDir()).toBe(workspaceRoot);
  });
});

describe("resolveHarnessSourceRoot", () => {
  let tempRoot = "";

  beforeEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-source-root-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    const guiDir = path.join(tempRoot, "apps", "gui");
    await mkdir(guiDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.HARNESS_REPO_ROOT;
    delete process.env.P_DEV_HOME;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("walks up from apps/gui even when P_DEV_HOME points elsewhere", () => {
    process.env.P_DEV_HOME = path.join(tempRoot, "operator-workspace");
    const guiDir = path.join(tempRoot, "apps", "gui");
    expect(resolveHarnessSourceRoot(guiDir)).toBe(tempRoot);
  });
});
