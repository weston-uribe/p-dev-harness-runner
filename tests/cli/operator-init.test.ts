import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOperatorInit } from "../../src/cli/commands/operator-init.js";
import { EXIT_SUCCESS } from "../../src/cli/exit-codes.js";
import { loadConfig } from "../../src/config/load-config.js";

const ENV_EXAMPLE = `# test example
HARNESS_CONFIG_PATH=.harness/config.local.json
LINEAR_API_KEY=
`;

const CONFIG_EXAMPLE = JSON.stringify(
  {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        linearProjects: ["Example Target App"],
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "dev",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  },
  null,
  2,
);

describe("runOperatorInit", () => {
  let tempRoot = "";
  let originalCwd = "";

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-operator-init-"));
    await writeFile(path.join(tempRoot, ".env.example"), ENV_EXAMPLE, "utf8");
    await mkdirHarnessExample(tempRoot);
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates .env.local when missing", async () => {
    const exitCode = await runOperatorInit();
    expect(exitCode).toBe(EXIT_SUCCESS);

    const envLocal = await readFile(path.join(tempRoot, ".env.local"), "utf8");
    expect(envLocal).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
  });

  it("creates .harness/config.local.json when missing", async () => {
    const exitCode = await runOperatorInit();
    expect(exitCode).toBe(EXIT_SUCCESS);

    const configLocal = await readFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      "utf8",
    );
    expect(configLocal).toContain('"id": "target-app"');
  });

  it("does not overwrite existing files by default", async () => {
    await writeFile(path.join(tempRoot, ".env.local"), "SENTINEL_ENV", "utf8");
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      "SENTINEL_CONFIG",
      "utf8",
    );

    await runOperatorInit();

    expect(await readFile(path.join(tempRoot, ".env.local"), "utf8")).toBe(
      "SENTINEL_ENV",
    );
    expect(
      await readFile(path.join(tempRoot, ".harness", "config.local.json"), "utf8"),
    ).toBe("SENTINEL_CONFIG");
  });

  it("overwrites existing files with --force", async () => {
    await writeFile(path.join(tempRoot, ".env.local"), "SENTINEL_ENV", "utf8");
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      "SENTINEL_CONFIG",
      "utf8",
    );

    await runOperatorInit({ force: true });

    const envLocal = await readFile(path.join(tempRoot, ".env.local"), "utf8");
    expect(envLocal).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(envLocal).not.toBe("SENTINEL_ENV");

    const configLocal = await readFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      "utf8",
    );
    expect(configLocal).toContain('"id": "target-app"');
    expect(configLocal).not.toBe("SENTINEL_CONFIG");
  });

  it("generated local config parses with loadConfig", async () => {
    await runOperatorInit();

    const config = await loadConfig(
      path.join(tempRoot, ".harness", "config.local.json"),
    );
    expect(config.repos[0]?.id).toBe("target-app");
  });
});

describe("committed operator examples", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  it("committed examples contain no operator-specific references", async () => {
    const envExample = await readFile(
      path.join(repoRoot, ".env.example"),
      "utf8",
    );
    const configExample = await readFile(
      path.join(repoRoot, ".harness", "config.example.json"),
      "utf8",
    );

    const forbidden = /weston-uribe|weston/i;
    expect(envExample).not.toMatch(forbidden);
    expect(configExample).not.toMatch(forbidden);
  });
});

async function mkdirHarnessExample(root: string): Promise<void> {
  const harnessDir = path.join(root, ".harness");
  await mkdir(harnessDir, { recursive: true });
  await writeFile(
    path.join(harnessDir, "config.example.json"),
    CONFIG_EXAMPLE,
    "utf8",
  );
}
