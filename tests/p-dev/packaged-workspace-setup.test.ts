import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHarnessDispatchRepo } from "../../src/setup/harness-dispatch-repo.js";
import { buildRemoteSetupSummary } from "../../src/setup/remote-setup-summary.js";
import { deriveStep6RemoteActionEligibility } from "../../src/setup/first-run-readiness.js";
import { seedWorkspaceTemplates } from "../../src/p-dev/workspace.js";

describe("packaged workspace setup", () => {
  let tempRoot = "";
  let workspaceDir = "";
  const originalDispatchRepo = process.env.GITHUB_DISPATCH_REPOSITORY;

  beforeEach(async () => {
    delete process.env.GITHUB_DISPATCH_REPOSITORY;
    tempRoot = await mkdtemp(path.join(tmpdir(), "p-dev-packaged-setup-"));
    workspaceDir = path.join(tempRoot, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const templatesDir = path.join(tempRoot, "templates");
    await mkdir(path.join(templatesDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(templatesDir, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(templatesDir, ".harness", "config.example.json"),
      JSON.stringify({ version: 1, repos: [], allowedTargetRepos: [] }, null, 2),
      "utf8",
    );
    await seedWorkspaceTemplates({
      workspaceDir,
      templatesDir,
    });
  });

  afterEach(async () => {
    if (originalDispatchRepo === undefined) {
      delete process.env.GITHUB_DISPATCH_REPOSITORY;
    } else {
      process.env.GITHUB_DISPATCH_REPOSITORY = originalDispatchRepo;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not infer a harness repo from a no-git packaged workspace", async () => {
    const resolution = await resolveHarnessDispatchRepo({ cwd: workspaceDir });
    expect(resolution.resolved).toBe(false);
    expect(resolution.repo).toBeNull();
  });

  it("blocks Step 6 remote actions until harness repo identity is resolved", async () => {
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_TOKEN=ghp_test_token",
      ].join("\n"),
      "utf8",
    );

    const summary = await buildRemoteSetupSummary({ cwd: workspaceDir });
    expect(summary.harnessDispatchRepoResolved).toBe(false);

    const eligibility = deriveStep6RemoteActionEligibility(summary);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.route).toBe("step4-harness-repo");
  });

  it("resolves an explicitly saved harness dispatch repo after Step 4 apply", async () => {
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=owner/private-harness",
        "GITHUB_TOKEN=ghp_test_token",
      ].join("\n"),
      "utf8",
    );

    const resolution = await resolveHarnessDispatchRepo({ cwd: workspaceDir });
    expect(resolution.resolved).toBe(true);
    expect(resolution.repo).toBe("owner/private-harness");
    expect(resolution.source).toBe("env-local");
  });
});
