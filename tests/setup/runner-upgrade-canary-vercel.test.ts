import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintHarnessConfigBytes } from "../../src/config/cloud-config-fingerprint.js";
import { harnessConfigSchema } from "../../src/config/schema.js";
import { computeGitBlobSha1 } from "../../src/p-dev/git-object-plumbing.js";
import { buildWorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-manifest.js";
import { formatHarnessConfigJson } from "../../src/setup/config-builder.js";
import {
  buildHarnessSnapshotManagedRepoMarker,
  HARNESS_MANAGED_REPO_MARKER_FILE,
} from "../../src/setup/harness-managed-repo-marker.js";
import { runRunnerConfigCanary } from "../../src/setup/runner-upgrade-canary.js";

vi.mock("../../src/setup/vercel-setup-client.js", () => ({
  listVercelTeams: vi.fn().mockResolvedValue([{ id: "team_1", name: "t" }]),
}));

const PORTFOLIO = "https://github.com/weston-uribe/weston-uribe-portfolio";

function managedMarkerJson(): string {
  const readme = Buffer.from("# canary\n", "utf8");
  const manifest = buildWorkspaceSnapshotManifest({
    packageVersion: "0.3.1",
    sourceCommit: "a".repeat(40),
    entries: [
      {
        path: "README.md",
        type: "file",
        mode: "100644",
        size: readme.byteLength,
        content: readme,
        gitBlobSha1: computeGitBlobSha1(readme),
      },
    ],
  });
  return `${JSON.stringify(
    buildHarnessSnapshotManagedRepoMarker({
      repository: "weston-uribe/p-dev-harness-runner",
      repositoryId: 1_304_282_812,
      manifest,
      snapshotCommitSha: "c".repeat(40),
      defaultBranch: "main",
    }),
    null,
    2,
  )}\n`;
}

function vercelRequiredConfig() {
  return harnessConfigSchema.parse({
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "portfolio",
        targetRepo: PORTFOLIO,
        baseBranch: "dev",
        productionBranch: "main",
        previewProvider: "vercel",
        linearAssociations: [
          {
            workspaceId: "ws-fresh",
            teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
            teamKey: "FRE",
            teamName: "fresh p-dev linear team",
            projectId: "63125fbb-f05a-43de-8496-c8a798e39f6b",
            projectName: "harness",
          },
        ],
      },
    ],
    allowedTargetRepos: [PORTFOLIO],
    linear: {
      teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
      teamKey: "FRE",
    },
    roleModels: {
      planner: { id: "composer-2.5" },
      builder: { id: "composer-2.5" },
    },
  });
}

describe("runner config canary vercel production credential", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when required VERCEL_TOKEN is absent", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "canary-vercel-absent-"));
    await mkdir(path.join(dir, ".harness"), { recursive: true });
    await writeFile(
      path.join(dir, HARNESS_MANAGED_REPO_MARKER_FILE),
      managedMarkerJson(),
      "utf8",
    );

    const config = vercelRequiredConfig();
    const bytes = Buffer.from(formatHarnessConfigJson(config), "utf8");
    const result = await runRunnerConfigCanary(dir, {
      GITHUB_ACTIONS: "true",
      HARNESS_CONFIG_JSON_B64: bytes.toString("base64"),
      HARNESS_CONFIG_FINGERPRINT: fingerprintHarnessConfigBytes(bytes),
    });

    expect(result.ok).toBe(false);
    expect(result.vercelProductionCredentialOk).toBe(false);
    expect(result.vercelProductionCredentialClassification).toBe(
      "secret_name_absent",
    );
    expect(result.vercelProductionAffectedRepoIds).toContain("portfolio");
    expect(JSON.stringify(result)).not.toMatch(/eyJ/);
  });

  it("passes when required VERCEL_TOKEN authenticates", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "canary-vercel-ok-"));
    await mkdir(path.join(dir, ".harness"), { recursive: true });
    await writeFile(
      path.join(dir, HARNESS_MANAGED_REPO_MARKER_FILE),
      managedMarkerJson(),
      "utf8",
    );

    const config = vercelRequiredConfig();
    const bytes = Buffer.from(formatHarnessConfigJson(config), "utf8");
    const result = await runRunnerConfigCanary(dir, {
      GITHUB_ACTIONS: "true",
      HARNESS_CONFIG_JSON_B64: bytes.toString("base64"),
      HARNESS_CONFIG_FINGERPRINT: fingerprintHarnessConfigBytes(bytes),
      VERCEL_TOKEN: "test-vercel-token-must-not-leak",
    });

    expect(result.vercelProductionCredentialOk).toBe(true);
    expect(result.vercelProductionCredentialClassification).toBe(
      "successful_read_only_authentication",
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "test-vercel-token-must-not-leak",
    );
  });
});
