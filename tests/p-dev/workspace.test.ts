import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPathInsidePackageInstall,
  resolveWorkspaceDir,
  seedWorkspaceTemplates,
} from "../../src/p-dev/workspace.js";

describe("p-dev workspace", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-workspace-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prefers cli workspace over env and default", () => {
    expect(
      resolveWorkspaceDir({
        cliWorkspace: "/tmp/cli",
        envWorkspace: "/tmp/env",
        homeDir: "/tmp/home",
      }),
    ).toEqual({ workspaceDir: path.resolve("/tmp/cli"), source: "cli" });

    expect(
      resolveWorkspaceDir({
        envWorkspace: "/tmp/env",
        homeDir: "/tmp/home",
      }),
    ).toEqual({ workspaceDir: path.resolve("/tmp/env"), source: "env" });

    expect(resolveWorkspaceDir({ homeDir: "/tmp/home" })).toEqual({
      workspaceDir: path.join("/tmp/home", ".p-dev"),
      source: "default",
    });
  });

  it("seeds templates without overwriting existing files", async () => {
    const workspaceDir = path.join(tempRoot, "workspace");
    const templatesDir = path.join(tempRoot, "templates");
    await mkdir(path.join(templatesDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(templatesDir, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(templatesDir, ".harness", "config.example.json"),
      '{"version":1}\n',
      "utf8",
    );

    const first = await seedWorkspaceTemplates({ workspaceDir, templatesDir });
    expect(first.seeded).toHaveLength(2);

    await writeFile(
      path.join(workspaceDir, ".env.local"),
      "LINEAR_API_KEY=existing\n",
      "utf8",
    );

    const second = await seedWorkspaceTemplates({ workspaceDir, templatesDir });
    expect(second.seeded).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
    expect(await readFile(path.join(workspaceDir, ".env.local"), "utf8")).toBe(
      "LINEAR_API_KEY=existing\n",
    );
  });

  it("detects paths inside the package install directory", () => {
    expect(isPathInsidePackageInstall("/pkg/gui", "/pkg")).toBe(true);
    expect(isPathInsidePackageInstall("/tmp/workspace", "/pkg")).toBe(false);
  });
});
