import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeDryRun } from "../../src/runner/dry-run.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("executeDryRun", () => {
  it("runs fixture dry-run successfully without network", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "harness-runs-"));
    const config = {
      version: 1 as const,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: tempRoot,
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "main",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/owner/example-target-app",
      ],
    };
    const configPath = path.join(tempRoot, "harness.config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(configPath, JSON.stringify(config), "utf8"),
    );

    const fixturePath = path.join(
      repoRoot,
      "tests/fixtures/issues/valid-target-app.md",
    );

    const result = await executeDryRun({
      issueKey: "WES-FIXTURE",
      configPath,
      fixturePath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.targetRepo).toBe(
      "https://github.com/owner/example-target-app",
    );
    expect(result.manifest.dryRun).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("classifies unknown repo denial", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "harness-runs-"));
    const configPath = path.join(repoRoot, "harness.config.json");
    const fixturePath = path.join(
      repoRoot,
      "tests/fixtures/issues/unknown-repo.md",
    );

    const originalLogDir = process.env.HARNESS_TEST_LOG_DIR;
    process.env.HARNESS_TEST_LOG_DIR = tempRoot;

    const config = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(configPath, "utf8"),
      ),
    );
    config.logDirectory = tempRoot;
    const tempConfigPath = path.join(tempRoot, "config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(tempConfigPath, JSON.stringify(config), "utf8"),
    );

    const result = await executeDryRun({
      issueKey: "WES-UNKNOWN",
      configPath: tempConfigPath,
      fixturePath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest.errorClassification).toBe("unknown_repo_denied");

    if (originalLogDir === undefined) {
      delete process.env.HARNESS_TEST_LOG_DIR;
    } else {
      process.env.HARNESS_TEST_LOG_DIR = originalLogDir;
    }

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("classifies ambiguous issue", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "harness-runs-"));
    const configPath = path.join(repoRoot, "harness.config.json");
    const fixturePath = path.join(
      repoRoot,
      "tests/fixtures/issues/missing-acceptance-criteria.md",
    );

    const config = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(configPath, "utf8"),
      ),
    );
    config.logDirectory = tempRoot;
    const tempConfigPath = path.join(tempRoot, "config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(tempConfigPath, JSON.stringify(config), "utf8"),
    );

    const result = await executeDryRun({
      issueKey: "WES-BAD",
      configPath: tempConfigPath,
      fixturePath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest.errorClassification).toBe("ambiguous_issue");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
