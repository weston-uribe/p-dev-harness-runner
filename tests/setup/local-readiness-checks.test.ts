import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/linear/client.js", () => ({
  pingLinear: vi.fn(),
}));

vi.mock("../../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/client.js")>();
  return {
    ...actual,
    GitHubClient: vi.fn(),
  };
});

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    me: vi.fn(),
    models: {
      list: vi.fn(),
    },
    repositories: {
      list: vi.fn(),
    },
  },
}));

import { pingLinear } from "../../src/linear/client.js";
import { GitHubClient } from "../../src/github/client.js";
import { runLocalReadinessChecks } from "../../src/setup/local-readiness-checks.js";
import { GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE } from "../../src/setup/github-workflow-permissions.js";

const CONFIG_EXAMPLE = JSON.stringify(
  {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "my-product",
        linearProjects: ["My Product"],
        targetRepo: "https://github.com/acme/my-product",
        baseBranch: "dev",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: ["https://github.com/acme/my-product"],
  },
  null,
  2,
);

function mockGitHubClient(
  implementation: Partial<{
    inspectAuthenticatedUser: () => Promise<{
      login: string;
      oauthScopes: string[];
      tokenType: string | null;
    }>;
    getRepository: () => Promise<{
      permissions?: {
        pull?: boolean;
        push?: boolean;
      };
    }>;
    listActionsWorkflows: () => Promise<{ total_count: number }>;
  }>,
) {
  vi.mocked(GitHubClient).mockImplementation(
    () =>
      ({
        inspectAuthenticatedUser: vi
          .fn()
          .mockResolvedValue({
            login: "weston-uribe",
            oauthScopes: ["repo", "workflow"],
            tokenType: "classic",
          }),
        getRepository: vi.fn().mockResolvedValue({
          permissions: { pull: true, push: true },
        }),
        listActionsWorkflows: vi.fn().mockResolvedValue({ total_count: 0 }),
        ...implementation,
      }) as unknown as InstanceType<typeof GitHubClient>,
  );
}

describe("local-readiness-checks", () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-readiness-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
        "LINEAR_API_KEY=lin_test_key",
        "CURSOR_API_KEY=cur_test_key",
        "GITHUB_TOKEN=ghp_test_token",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      CONFIG_EXAMPLE,
      "utf8",
    );

    vi.mocked(pingLinear).mockResolvedValue("Weston Uribe");
    mockGitHubClient({});

    const cursorSdk = await import("@cursor/sdk");
    vi.mocked(cursorSdk.Cursor.me).mockResolvedValue({
      apiKeyName: "Production API Key",
      userEmail: "weston@example.com",
      userFirstName: "Weston",
      userLastName: "Uribe",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    vi.mocked(cursorSdk.Cursor.models.list).mockResolvedValue([{ id: "composer-2.5" }]);
    vi.mocked(cursorSdk.Cursor.repositories.list).mockResolvedValue([]);
  });

  it("runs GUI-owned local readiness checks without CLI-only skipped rows", async () => {
    const result = await runLocalReadinessChecks({ cwd: tempRoot });

    expect(result.allPassed).toBe(true);
    expect(result.checks.some((check) => check.label === "Linear API key works")).toBe(
      true,
    );
    expect(result.checks.some((check) => check.label === "Cursor API key works")).toBe(
      true,
    );
    expect(
      result.checks.some((check) => check.label === "GitHub token supports guided setup"),
    ).toBe(true);
    expect(
      result.checks.some((check) =>
        check.label.includes("Target repo acme/my-product supports workflow install"),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("CLI-only");
    expect(JSON.stringify(result)).not.toContain("Milestone 3");
    expect(JSON.stringify(result)).not.toContain("npm run harness:doctor");
  });

  it("marks saved provider keys as failed when verification fails", async () => {
    vi.mocked(pingLinear).mockRejectedValueOnce(new Error("Unauthorized"));

    const result = await runLocalReadinessChecks({ cwd: tempRoot });
    const linear = result.checks.find((check) => check.id === "linear-key");

    expect(linear?.status).toBe("failed");
    expect(linear?.action).toContain("Step 1");
    expect(result.allPassed).toBe(false);
  });

  it("does not pass local readiness when GitHub token lacks workflow scope", async () => {
    mockGitHubClient({
      inspectAuthenticatedUser: vi.fn().mockResolvedValue({
        login: "weston-uribe",
        oauthScopes: ["repo"],
        tokenType: "classic",
      }),
    });

    const result = await runLocalReadinessChecks({ cwd: tempRoot });
    const github = result.checks.find((check) => check.id === "github-token");
    const targetRepo = result.checks.find((check) =>
      check.id.startsWith("target-repo-"),
    );

    expect(github?.status).toBe("failed");
    expect(github?.detail).toContain(GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE);
    expect(targetRepo?.status).toBe("failed");
    expect(result.allPassed).toBe(false);
  });

  it("reports missing config using the operator workspace path", async () => {
    await rm(path.join(tempRoot, ".harness", "config.local.json"));

    const result = await runLocalReadinessChecks({ cwd: tempRoot });
    const configParse = result.checks.find((check) => check.id === "config-parses");
    const configExists = result.checks.find(
      (check) => check.id === "config-local-exists",
    );

    expect(configParse?.status).toBe("failed");
    expect(configParse?.detail).toContain(tempRoot);
    expect(configExists?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("lin_test_key");
    expect(JSON.stringify(result)).not.toContain("ghp_test_token");
  });
});
