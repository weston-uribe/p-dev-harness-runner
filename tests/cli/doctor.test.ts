import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pingLinear: vi.fn(),
  pingGitHub: vi.fn(),
  loadReconcileHeartbeat: vi.fn(),
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

vi.mock("../../src/workflow/reconcile-heartbeat-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/workflow/reconcile-heartbeat-store.js")>();
  return {
    ...actual,
    loadReconcileHeartbeat: mocks.loadReconcileHeartbeat,
  };
});

import { runDoctor } from "../../src/cli/commands/doctor.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";
import {
  buildReconcileHeartbeat,
  RECONCILE_HEARTBEAT_STALE_MS,
} from "../../src/workflow/reconcile-health.js";

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
    // Missing heartbeat without state token is skipped (not a phase blocker).
    mocks.loadReconcileHeartbeat.mockResolvedValue(null);
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_DISPATCH_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.P_DEV_STATE_GITHUB_TOKEN;
    vi.clearAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails when GITHUB_TOKEN is missing", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
    const code = await runDoctor({ configPath });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("passes merge profile without CURSOR_API_KEY", async () => {
    delete process.env.CURSOR_API_KEY;
    process.env.GITHUB_TOKEN = "test-github";
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";
    const code = await runDoctor({ configPath, profile: "merge" });
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("passes when required tokens are valid", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";
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
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";

    const code = await runDoctor({ configPath, profile: "merge" });

    expect(code).toBe(EXIT_CONFIG);
  });

  it("FRE-7 shaped: full profile proceeds with stale reconcile heartbeat when critical deps healthy", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";
    process.env.P_DEV_STATE_GITHUB_TOKEN = "test-state";
    mocks.loadReconcileHeartbeat.mockResolvedValue(
      buildReconcileHeartbeat({
        finishedAt: new Date(
          Date.now() - RECONCILE_HEARTBEAT_STALE_MS - 60_000,
        ).toISOString(),
        candidatesFound: 0,
        opaqueDispatches: 0,
        statusesScanned: ["Plan Review", "Code Review"],
        outcome: "success",
        workflowRunId: "29800000000",
      }),
    );

    const code = await runDoctor({ configPath, profile: "full" });
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("FRE-6 shaped: merge profile proceeds with stale heartbeat when dispatch token present", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";
    process.env.P_DEV_STATE_GITHUB_TOKEN = "test-state";
    mocks.loadReconcileHeartbeat.mockResolvedValue(
      buildReconcileHeartbeat({
        finishedAt: new Date(
          Date.now() - RECONCILE_HEARTBEAT_STALE_MS - 60_000,
        ).toISOString(),
        candidatesFound: 0,
        opaqueDispatches: 0,
        statusesScanned: ["Ready to Merge"],
        outcome: "success",
      }),
    );

    const code = await runDoctor({ configPath, profile: "merge" });
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("reconciler profile fails on stale heartbeat", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    process.env.HARNESS_GITHUB_TOKEN = "test-dispatch";
    process.env.P_DEV_STATE_GITHUB_TOKEN = "test-state";
    mocks.loadReconcileHeartbeat.mockResolvedValue(
      buildReconcileHeartbeat({
        finishedAt: new Date(
          Date.now() - RECONCILE_HEARTBEAT_STALE_MS - 60_000,
        ).toISOString(),
        candidatesFound: 0,
        opaqueDispatches: 0,
        statusesScanned: ["Code Review"],
        outcome: "success",
      }),
    );

    const code = await runDoctor({ configPath, profile: "reconciler" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("merge profile still fails when dispatch token is missing", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.GITHUB_DISPATCH_TOKEN;

    const code = await runDoctor({ configPath, profile: "merge" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("production profile fails closed when required VERCEL_TOKEN is absent", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: path.join(tempRoot, "runs"),
        repos: [
          {
            id: "portfolio",
            linearProjects: ["Portfolio"],
            targetRepo: "https://github.com/owner/portfolio",
            baseBranch: "dev",
            productionBranch: "main",
            previewProvider: "vercel",
            validation: { commands: ["npm test"] },
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/portfolio"],
      }),
      "utf8",
    );
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    delete process.env.VERCEL_TOKEN;

    const code = await runDoctor({ configPath, profile: "production" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("agent profile passes without VERCEL_TOKEN on vercel-qualified repo", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: path.join(tempRoot, "runs"),
        repos: [
          {
            id: "portfolio",
            linearProjects: ["Portfolio"],
            targetRepo: "https://github.com/owner/portfolio",
            baseBranch: "dev",
            productionBranch: "main",
            previewProvider: "vercel",
            validation: { commands: ["npm test"] },
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/portfolio"],
      }),
      "utf8",
    );
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    delete process.env.VERCEL_TOKEN;

    const code = await runDoctor({ configPath, profile: "agent" });
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("agent profile does not call Vercel credential authentication", async () => {
    const vercelAuth = vi.spyOn(
      await import("../../src/setup/vercel-production-credential.js"),
      "verifyVercelProductionCredentialAuth",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: path.join(tempRoot, "runs"),
        repos: [
          {
            id: "portfolio",
            linearProjects: ["Portfolio"],
            targetRepo: "https://github.com/owner/portfolio",
            baseBranch: "dev",
            productionBranch: "main",
            previewProvider: "vercel",
            validation: { commands: ["npm test"] },
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/portfolio"],
      }),
      "utf8",
    );
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    process.env.VERCEL_TOKEN = "should-not-be-used";

    const code = await runDoctor({ configPath, profile: "agent" });
    expect(code).toBe(EXIT_SUCCESS);
    expect(vercelAuth).not.toHaveBeenCalled();
    vercelAuth.mockRestore();
  });

  it("agent profile fails without LINEAR_API_KEY", async () => {
    delete process.env.LINEAR_API_KEY;
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    const code = await runDoctor({ configPath, profile: "agent" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("agent profile fails without CURSOR_API_KEY", async () => {
    delete process.env.CURSOR_API_KEY;
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    const code = await runDoctor({ configPath, profile: "agent" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("agent profile fails without GitHub dispatch credentials", async () => {
    process.env.GITHUB_TOKEN = "test-github";
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const code = await runDoctor({ configPath, profile: "agent" });
    expect(code).toBe(EXIT_CONFIG);
  });

  it("full profile still documents Vercel as critical when token missing on qualified repo", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: path.join(tempRoot, "runs"),
        repos: [
          {
            id: "portfolio",
            linearProjects: ["Portfolio"],
            targetRepo: "https://github.com/owner/portfolio",
            baseBranch: "dev",
            productionBranch: "main",
            previewProvider: "vercel",
            validation: { commands: ["npm test"] },
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/portfolio"],
      }),
      "utf8",
    );
    process.env.GITHUB_TOKEN = "test-github";
    process.env.GITHUB_DISPATCH_TOKEN = "test-dispatch";
    delete process.env.VERCEL_TOKEN;

    const code = await runDoctor({ configPath, profile: "full" });
    expect(code).toBe(EXIT_CONFIG);
  });
});
