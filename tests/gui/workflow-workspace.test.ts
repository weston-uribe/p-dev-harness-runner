import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../../src/workflow-page/linear-status-source.js", () => ({
  loadLiveLinearStatuses: vi.fn(),
}));

vi.mock("../../src/workflow-page/model-catalog.js", () => ({
  fetchLiveCursorModelCatalog: vi.fn(),
}));

import { loadLiveLinearStatuses } from "../../src/workflow-page/linear-status-source.js";
import { fetchLiveCursorModelCatalog } from "../../src/workflow-page/model-catalog.js";
import {
  normalizeHarnessEnvPaths,
  resolveHarnessRepoRoot,
  resolveHarnessWorkspaceDir,
} from "../../src/gui/repo-root.js";
import { loadWorkflowBootstrap } from "../../apps/gui/lib/workflow-server.js";
import { writeControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const FAKE_LINEAR_KEY = "fake-linear-secret-value";
const FAKE_CURSOR_KEY = "fake-cursor-secret-value";

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
    linear: { teamKey: "WES" },
  },
  null,
  2,
);

describe("workflow operator workspace contract", () => {
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

    await mkdir(path.join(operatorRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(operatorRoot, ".env.local"),
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        `LINEAR_API_KEY=${FAKE_LINEAR_KEY}`,
        `CURSOR_API_KEY=${FAKE_CURSOR_KEY}`,
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(operatorRoot, ".harness", "config.local.json"),
      CONFIG_JSON,
      "utf8",
    );
    await writeControlPlaneSetupState(
      {
        version: 1,
        linear: {
          teamId: "team-123",
          teamKey: "WES",
          teamName: "Weston",
        },
      },
      operatorRoot,
    );

    vi.mocked(loadLiveLinearStatuses).mockResolvedValue({
      statuses: [{ id: "status-1", name: "Todo", type: "unstarted" }],
      loadState: "loaded",
    });
    vi.mocked(fetchLiveCursorModelCatalog).mockResolvedValue({
      catalog: [
        {
          id: "composer-2.5",
          availability: "available",
          supportedParameters: [],
        },
      ],
      loadState: "loaded",
    });
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
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(operatorRoot, { recursive: true, force: true });
  });

  it("uses P_DEV_HOME for workflow bootstrap when source root differs", () => {
    expect(resolveHarnessWorkspaceDir()).toBe(operatorRoot);
    expect(resolveHarnessRepoRoot()).toBe(sourceRoot);
  });

  it("loads Linear from operator workspace credentials, not source-only secrets", async () => {
    await writeFile(
      path.join(sourceRoot, ".env.local"),
      `LINEAR_API_KEY=source-only-linear-key\nCURSOR_API_KEY=source-only-cursor-key\n`,
      "utf8",
    );
    normalizeHarnessEnvPaths(operatorRoot);

    const payload = await loadWorkflowBootstrap({
      mode: "live",
      scopeId: "my-product",
    });

    expect(payload.catalogLoadMetadata.statusCatalog).toBe("loaded");
    expect(vi.mocked(loadLiveLinearStatuses)).toHaveBeenCalledWith({
      apiKey: FAKE_LINEAR_KEY,
      teamId: "team-123",
    });
    expect(JSON.stringify(payload)).not.toContain("source-only-linear-key");
  });

  it("workflow-server reads operator workspace for bootstrap", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/lib/workflow-server.ts"),
      "utf8",
    );

    expect(source).toContain("resolveHarnessWorkspaceDir");
    expect(source).not.toContain("resolveHarnessRepoRoot");
  });

  it("verify routes read operator workspace for setup verification", () => {
    const verifyService = readFileSync(
      path.join(repoRoot, "apps/gui/app/api/setup/verify-service/route.ts"),
      "utf8",
    );
    const verifyTargetRepo = readFileSync(
      path.join(repoRoot, "apps/gui/app/api/setup/verify-target-repo/route.ts"),
      "utf8",
    );

    expect(verifyService).toContain("resolveHarnessWorkspaceDir");
    expect(verifyTargetRepo).toContain("resolveHarnessWorkspaceDir");
  });
});
