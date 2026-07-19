import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    models: { list: vi.fn() },
    repositories: { list: vi.fn() },
  },
}));

import { pingLinear } from "../../src/linear/client.js";
import { GitHubClient } from "../../src/github/client.js";
import {
  runLocalReadinessChecks,
  runLocalReadinessChecksProgress,
} from "../../src/setup/local-readiness-checks.js";

const CONFIG_JSON = JSON.stringify(
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

const FAKE_SECRETS = {
  linearApiKey: "fake-linear-secret-value",
  cursorApiKey: "fake-cursor-secret-value",
  githubToken: "fake-github-secret-value",
};

function mockGitHubClient() {
  vi.mocked(GitHubClient).mockImplementation(
    () =>
      ({
        inspectAuthenticatedUser: vi.fn().mockResolvedValue({
          login: "weston-uribe",
          oauthScopes: ["repo", "workflow"],
          tokenType: "classic",
        }),
        getRepository: vi.fn().mockResolvedValue({
          permissions: { pull: true, push: true },
        }),
        listActionsWorkflows: vi.fn().mockResolvedValue({ total_count: 1 }),
      }) as unknown as InstanceType<typeof GitHubClient>,
  );
}

async function seedOperatorWorkspace(operatorRoot: string): Promise<void> {
  await mkdir(path.join(operatorRoot, ".harness"), { recursive: true });
  await writeFile(
    path.join(operatorRoot, ".env.local"),
    [
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
      `LINEAR_API_KEY=${FAKE_SECRETS.linearApiKey}`,
      `CURSOR_API_KEY=${FAKE_SECRETS.cursorApiKey}`,
      `GITHUB_TOKEN=${FAKE_SECRETS.githubToken}`,
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(operatorRoot, ".harness", "config.local.json"),
    CONFIG_JSON,
    "utf8",
  );
}

describe("local readiness progress stream", () => {
  let operatorRoot = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    operatorRoot = await mkdtemp(path.join(tmpdir(), "harness-operator-"));
    vi.mocked(pingLinear).mockResolvedValue("Weston Uribe");
    mockGitHubClient();
    const cursorSdk = await import("@cursor/sdk");
    vi.mocked(cursorSdk.Cursor.me).mockResolvedValue({
      apiKeyName: "Production API Key",
      userEmail: "weston@example.com",
    } as never);
    vi.mocked(cursorSdk.Cursor.models.list).mockResolvedValue([
      { id: "composer-2.5" },
    ]);
    vi.mocked(cursorSdk.Cursor.repositories.list).mockResolvedValue([]);
    await seedOperatorWorkspace(operatorRoot);
  });

  afterEach(async () => {
    await rm(operatorRoot, { recursive: true, force: true });
  });

  it("emits started and completed events in execution order", async () => {
    const events = [];
    for await (const event of runLocalReadinessChecksProgress({
      cwd: operatorRoot,
    })) {
      events.push(event);
    }

    const startedIds = events
      .filter((event) => event.type === "check-started")
      .map((event) => event.id);
    const completedIds = events
      .filter((event) => event.type === "check-completed")
      .map((event) => event.check.id);

    expect(startedIds.length).toBeGreaterThan(0);
    expect(completedIds).toEqual(startedIds);
    expect(events.at(-1)?.type).toBe("run-completed");
    expect(events.at(-1)).toMatchObject({ allPassed: true });
  });

  it("collector and progress paths return the same check ids", async () => {
    const collected = await runLocalReadinessChecks({ cwd: operatorRoot });
    const progressIds: string[] = [];
    for await (const event of runLocalReadinessChecksProgress({
      cwd: operatorRoot,
    })) {
      if (event.type === "check-completed") {
        progressIds.push(event.check.id);
      }
    }

    expect(progressIds).toEqual(collected.checks.map((check) => check.id));
  });
});
