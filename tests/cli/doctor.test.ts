import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pingLinear: vi.fn(),
  pingGitHub: vi.fn(),
}));

vi.mock("../../src/linear/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/linear/client.js")>();
  return {
    ...actual,
    pingLinear: mocks.pingLinear,
  };
});

vi.mock("../../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/client.js")>();
  return {
    ...actual,
    pingGitHub: mocks.pingGitHub,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getBranchRef: vi.fn().mockResolvedValue({ object: { sha: "abc123" } }),
      getRepository: vi.fn().mockResolvedValue({ permissions: { push: true } }),
    })),
  };
});

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: { list: vi.fn().mockResolvedValue([{ id: "composer-2.5" }]) },
    repositories: { list: vi.fn().mockResolvedValue([{ name: "target-app" }]) },
  },
}));

import { runDoctor } from "../../src/cli/commands/doctor.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";

describe("runDoctor", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-doctor-"));
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: path.join(tempRoot, "runs"),
        repos: [
          {
            id: "target-app",
            linearProjects: ["Example Target App"],
            targetRepo: "https://github.com/owner/example-target-app",
            baseBranch: "main",
            previewProvider: "vercel",
            validation: { commands: ["npm run lint"] },
          },
        ],
        allowedTargetRepos: [
          "https://github.com/owner/example-target-app",
        ],
      }),
      "utf8",
    );

    process.env.LINEAR_API_KEY = "test-linear";
    process.env.CURSOR_API_KEY = "test-cursor";
    mocks.pingLinear.mockResolvedValue("Weston");
    mocks.pingGitHub.mockResolvedValue("weston-uribe");
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    vi.clearAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails when GITHUB_TOKEN is missing", async () => {
    delete process.env.GITHUB_TOKEN;
    const code = await runDoctor({ configPath });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("passes merge profile without CURSOR_API_KEY", async () => {
    delete process.env.CURSOR_API_KEY;
    process.env.GITHUB_TOKEN = "test-github";
    const code = await runDoctor({ configPath, profile: "merge" });
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("passes when required tokens are valid", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    const code = await runDoctor({ configPath });
    expect(code).toBe(EXIT_SUCCESS);
    expect(mocks.pingGitHub).toHaveBeenCalledWith("test-github");
  });

  it("fails merge profile when GitHub token lacks PR head-branch write", async () => {
    const { GitHubClient } = await import("../../src/github/client.js");
    vi.mocked(GitHubClient).mockImplementationOnce(
      () =>
        ({
          getBranchRef: vi.fn().mockResolvedValue({ object: { sha: "abc123" } }),
          getRepository: vi.fn().mockResolvedValue({ permissions: { pull: true } }),
        }) as never,
    );
    process.env.GITHUB_TOKEN = "test-github";

    const code = await runDoctor({ configPath, profile: "merge" });

    expect(code).toBe(EXIT_CONFIG);
  });
});
