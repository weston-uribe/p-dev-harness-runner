import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  normalizeHarnessEnvPaths,
  resolveHarnessRepoRoot,
  resolveHarnessWorkspaceDir,
} from "../../src/gui/repo-root.js";
import { runLocalReadinessChecks } from "../../src/setup/local-readiness-checks.js";
import {
  applyLocalSetupFiles,
  previewLocalSetupFiles,
} from "../../src/setup/local-apply-actions.js";
import {
  resolveLocalFilePaths,
  resolveOperatorHarnessConfigPath,
} from "../../src/setup/setup-state.js";

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

function buildPayload() {
  return {
    env: {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: FAKE_SECRETS.linearApiKey,
      cursorApiKey: FAKE_SECRETS.cursorApiKey,
      githubToken: FAKE_SECRETS.githubToken,
    },
    config: {
      linearTeamKey: "WES",
      modelId: "composer-2.5",
      repos: [
        {
          id: "my-product",
          targetRepo: "https://github.com/acme/my-product",
          linearProjects: "My Product",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
    },
  };
}

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

describe("local readiness workspace root contract", () => {
  let sourceRoot = "";
  let operatorRoot = "";
  let previousRepoRoot: string | undefined;
  let previousDevHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousRepoRoot = process.env.HARNESS_REPO_ROOT;
    previousDevHome = process.env.P_DEV_HOME;

    sourceRoot = await mkdtemp(path.join(tmpdir(), "harness-source-"));
    operatorRoot = await mkdtemp(path.join(tmpdir(), "harness-operator-"));

    await writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "agentic-product-development-harness" }),
      "utf8",
    );
    await mkdir(path.join(sourceRoot, "apps", "gui"), { recursive: true });

    process.env.HARNESS_REPO_ROOT = sourceRoot;
    process.env.P_DEV_HOME = operatorRoot;

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
  });

  afterEach(async () => {
    if (previousRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = previousRepoRoot;
    }
    if (previousDevHome === undefined) {
      delete process.env.P_DEV_HOME;
    } else {
      process.env.P_DEV_HOME = previousDevHome;
    }
    delete process.env.HARNESS_CONFIG_PATH;
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(operatorRoot, { recursive: true, force: true });
  });

  it("uses P_DEV_HOME for operator workspace when source root differs", () => {
    expect(resolveHarnessWorkspaceDir()).toBe(operatorRoot);
    expect(resolveHarnessRepoRoot()).toBe(sourceRoot);
  });

  it("finds config in operator workspace when absent from source worktree", async () => {
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

    const result = await runLocalReadinessChecks({ cwd: operatorRoot });

    expect(result.checks.find((check) => check.id === "config-local-exists")?.status).toBe(
      "passed",
    );
    expect(result.checks.find((check) => check.id === "config-parses")?.status).toBe(
      "passed",
    );
    expect(result.checks.find((check) => check.id === "config-parses")?.detail).toContain(
      operatorRoot,
    );
  });

  it("does not satisfy readiness from config that exists only in source worktree", async () => {
    await mkdir(path.join(sourceRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, ".env.local"),
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
      path.join(sourceRoot, ".harness", "config.local.json"),
      CONFIG_JSON,
      "utf8",
    );

    const result = await runLocalReadinessChecks({ cwd: operatorRoot });
    const configParse = result.checks.find((check) => check.id === "config-parses");

    expect(configParse?.status).toBe("failed");
    expect(configParse?.detail).toContain(operatorRoot);
    expect(configParse?.detail).not.toContain(sourceRoot);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRETS.linearApiKey);
  });

  it("resolves relative HARNESS_CONFIG_PATH beneath operator workspace", async () => {
    const customRelative = ".harness/custom-config.json";
    await mkdir(path.join(operatorRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(operatorRoot, ".env.local"),
      `HARNESS_CONFIG_PATH=${customRelative}\nGITHUB_DISPATCH_REPOSITORY=owner/harness-repo\n`,
      "utf8",
    );
    await writeFile(
      path.join(operatorRoot, customRelative),
      CONFIG_JSON,
      "utf8",
    );

    normalizeHarnessEnvPaths(operatorRoot);
    const resolved = resolveOperatorHarnessConfigPath(operatorRoot);
    expect(resolved).toBe(path.join(operatorRoot, customRelative));

    const result = await runLocalReadinessChecks({ cwd: operatorRoot });
    expect(result.checks.find((check) => check.id === "config-parses")?.status).toBe(
      "passed",
    );
  });

  it("keeps absolute HARNESS_CONFIG_PATH unchanged", async () => {
    const absoluteConfig = path.join(operatorRoot, "custom", "absolute-config.json");
    await mkdir(path.dirname(absoluteConfig), { recursive: true });
    await writeFile(
      path.join(operatorRoot, ".env.local"),
      `HARNESS_CONFIG_PATH=${absoluteConfig}\nGITHUB_DISPATCH_REPOSITORY=owner/harness-repo\n`,
      "utf8",
    );
    await writeFile(absoluteConfig, CONFIG_JSON, "utf8");

    normalizeHarnessEnvPaths(operatorRoot);
    expect(resolveOperatorHarnessConfigPath(operatorRoot)).toBe(absoluteConfig);

    const result = await runLocalReadinessChecks({ cwd: operatorRoot });
    expect(result.checks.find((check) => check.id === "config-parses")?.detail).toBe(
      absoluteConfig,
    );
  });

  it("uses the same config path for Step 4 writer and Step 5 reader", async () => {
    const payload = buildPayload();
    const preview = await previewLocalSetupFiles({
      cwd: operatorRoot,
      payload,
    });
    const apply = await applyLocalSetupFiles({
      cwd: operatorRoot,
      payload,
      confirmed: true,
      fingerprint: preview.fingerprint,
    });

    const writerPath = apply.configResult.targetPath;
    const readerPaths = resolveLocalFilePaths(operatorRoot);
    const readiness = await runLocalReadinessChecks({ cwd: operatorRoot });

    expect(writerPath).toBe(readerPaths.configLocal);
    expect(
      readiness.checks.find((check) => check.id === "config-local-exists")?.status,
    ).toBe("passed");

    const envLocal = await readFile(path.join(operatorRoot, ".env.local"), "utf8");
    expect(envLocal).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(JSON.stringify({ apply, readiness })).not.toContain(
      FAKE_SECRETS.linearApiKey,
    );
  });
});
