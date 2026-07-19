import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLauncherEnv,
  computeLockfileFingerprint,
  dependencyState,
  hasOperatorConfigInDirectory,
  parseBootstrapArgv,
  resolveOperatorWorkspace,
  resolveSourceRepoRoot,
} from "../../bin/p-dev-dev-lib.js";

describe("p-dev-dev-lib", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-dev-lib-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    await writeFile(path.join(tempRoot, "package-lock.json"), "{}\n", "utf8");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves workspace precedence", async () => {
    const workspaceDir = path.join(tempRoot, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    expect(
      resolveOperatorWorkspace({
        cliWorkspace: workspaceDir,
        sourceRoot: tempRoot,
      }).workspaceDir,
    ).toBe(workspaceDir);

    expect(
      resolveOperatorWorkspace({
        env: { P_DEV_HOME: workspaceDir },
        sourceRoot: tempRoot,
      }).workspaceDir,
    ).toBe(workspaceDir);

    const sourceWithConfig = await mkdtemp(path.join(tmpdir(), "p-dev-source-config-"));
    await writeFile(
      path.join(sourceWithConfig, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    await writeFile(path.join(sourceWithConfig, ".env.local"), "X=1\n", "utf8");
    expect(
      resolveOperatorWorkspace({
        sourceRoot: sourceWithConfig,
      }).source,
    ).toBe("source-root");

    const defaultRoot = await mkdtemp(path.join(tmpdir(), "p-dev-default-root-"));
    await writeFile(
      path.join(defaultRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    expect(
      resolveOperatorWorkspace({
        sourceRoot: defaultRoot,
        homeDir: path.join(tempRoot, "home"),
      }).workspaceDir,
    ).toBe(path.join(tempRoot, "home", ".p-dev"));
    await rm(sourceWithConfig, { recursive: true, force: true });
    await rm(defaultRoot, { recursive: true, force: true });
  });

  it("detects operator config files", async () => {
    expect(hasOperatorConfigInDirectory(tempRoot)).toBe(false);
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      "{}",
      "utf8",
    );
    expect(hasOperatorConfigInDirectory(tempRoot)).toBe(true);
  });

  it("parses bootstrap argv without forwarding internal flags", () => {
    const parsed = parseBootstrapArgv([
      "--workspace",
      "/tmp/ws",
      "--deprecation-notice=configure",
      "--no-open",
    ]);
    expect(parsed.workspace).toBe("/tmp/ws");
    expect(parsed.deprecationNotice).toBe("configure");
    expect(parsed.forwardedArgv).toEqual(["--no-open"]);
  });

  it("builds launcher env with separated roots", () => {
    const env = buildLauncherEnv({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      env: {},
    });
    expect(env.HARNESS_REPO_ROOT).toBe(path.resolve("/src"));
    expect(env.P_DEV_HOME).toBe(path.resolve("/workspace"));
  });

  it("computes lockfile fingerprint", async () => {
    const fingerprint = computeLockfileFingerprint(
      path.join(tempRoot, "package-lock.json"),
    );
    expect(fingerprint).toHaveLength(64);
    await writeFile(path.join(tempRoot, "package-lock.json"), "{\n}\n", "utf8");
    expect(
      computeLockfileFingerprint(path.join(tempRoot, "package-lock.json")),
    ).not.toBe(fingerprint);
  });

  it("requires install when fingerprint is missing", async () => {
    await mkdir(path.join(tempRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(tempRoot, "node_modules", ".bin", "next"), "", "utf8");
    await writeFile(path.join(tempRoot, "node_modules", ".bin", "tsx"), "", "utf8");
    expect(dependencyState({ sourceRoot: tempRoot }).action).toBe("install");
  });

  it("resolves source root through symlink", async () => {
    const linked = path.join(tempRoot, "linked-bin");
    await mkdir(linked, { recursive: true });
    const target = path.join(tempRoot, "bin", "p-dev-dev.js");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "#!/usr/bin/env node\n", "utf8");
    await symlink(target, path.join(linked, "p-dev-dev.js"));
    expect(realpathSync(resolveSourceRepoRoot(path.join(linked, "p-dev-dev.js")))).toBe(
      realpathSync(tempRoot),
    );
  });

  it("supports repository paths containing spaces", async () => {
    const spacedRoot = path.join(tempRoot, "repo with spaces");
    await mkdir(spacedRoot, { recursive: true });
    await writeFile(
      path.join(spacedRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    const bootstrapPath = path.join(spacedRoot, "bin", "p-dev-dev.js");
    await mkdir(path.dirname(bootstrapPath), { recursive: true });
    await writeFile(bootstrapPath, "#!/usr/bin/env node\n", "utf8");
    expect(realpathSync(resolveSourceRepoRoot(bootstrapPath))).toBe(
      realpathSync(spacedRoot),
    );
  });
});
