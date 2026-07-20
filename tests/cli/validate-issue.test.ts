import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidateIssue } from "../../src/cli/commands/validate-issue.js";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("runValidateIssue", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-validate-cli-"));
    const config = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(path.join(repoRoot, "harness.config.json"), "utf8"),
      ),
    );
    config.logDirectory = path.join(tempRoot, "runs");
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("exits 0 for valid-minimal without intended phase", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/valid-minimal.md"),
    });
    expect(exitCode).toBe(EXIT_SUCCESS);
  });

  it("exits 2 for invalid-missing-task without intended phase", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/invalid-missing-task.md"),
    });
    expect(exitCode).toBe(EXIT_RUN_FAILURE);
  });

  it("exits 0 for valid-minimal with intended-phase planning", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/valid-minimal.md"),
      intendedPhase: "planning",
    });
    expect(exitCode).toBe(EXIT_SUCCESS);
  });

  it("exits 2 for invalid-missing-task with intended-phase planning", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/invalid-missing-task.md"),
      intendedPhase: "planning",
    });
    expect(exitCode).toBe(EXIT_RUN_FAILURE);
  });

  it("exits 0 for valid-minimal with intended-phase implementation", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/valid-minimal.md"),
      intendedPhase: "implementation",
    });
    expect(exitCode).toBe(EXIT_SUCCESS);
  });

  it("exits 0 for broad issue with intended-phase implementation", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/broad-for-direct-impl.md"),
      intendedPhase: "implementation",
    });
    expect(exitCode).toBe(EXIT_SUCCESS);
  });

  it("exits 1 for invalid intended phase", async () => {
    const exitCode = await runValidateIssue({
      configPath,
      filePath: path.join(repoRoot, "tests/fixtures/issues/valid-minimal.md"),
      intendedPhase: "foo",
    });
    expect(exitCode).toBe(EXIT_CONFIG);
  });

  it("exits 1 when neither file nor issue is provided", async () => {
    const exitCode = await runValidateIssue({ configPath });
    expect(exitCode).toBe(EXIT_CONFIG);
  });
});
