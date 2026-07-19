import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintHarnessConfigBytes } from "../../src/config/cloud-config-fingerprint.js";
import { harnessConfigSchema } from "../../src/config/schema.js";
import { computeGitBlobSha1 } from "../../src/p-dev/git-object-plumbing.js";
import {
  buildWorkspaceSnapshotManifest,
} from "../../src/p-dev/workspace-snapshot-manifest.js";
import { formatHarnessConfigJson } from "../../src/setup/config-builder.js";
import {
  buildHarnessSnapshotManagedRepoMarker,
  HARNESS_MANAGED_REPO_MARKER_FILE,
} from "../../src/setup/harness-managed-repo-marker.js";
import { runRunnerConfigCanary } from "../../src/setup/runner-upgrade-canary.js";
import {
  buildCanaryRunName,
  workflowRunMatchesCanaryOperationId,
} from "../../src/setup/runner-upgrade-canary-dispatch.js";
import { buildCanonicalCloudConfigPair } from "../../src/setup/sync-harness-config-cloud.js";

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
      repository: "weston-uribe/p-dev-harness",
      repositoryId: 1_304_282_812,
      manifest,
      snapshotCommitSha: "c".repeat(40),
      defaultBranch: "main",
    }),
    null,
    2,
  )}\n`;
}

function sampleConfig() {
  return harnessConfigSchema.parse({
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "portfolio",
        targetRepo: PORTFOLIO,
        baseBranch: "dev",
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

describe("runner config canary + cloud fingerprint sync", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("buildCanonicalCloudConfigPair uses formatHarnessConfigJson + fingerprintHarnessConfigBytes", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cloud-pair-"));
    await mkdir(path.join(dir, ".harness"), { recursive: true });
    const config = sampleConfig();
    // Deliberately non-canonical local formatting (compact JSON, no trailing newline).
    await writeFile(
      path.join(dir, ".harness", "config.local.json"),
      JSON.stringify(config),
      "utf8",
    );
    const pair = await buildCanonicalCloudConfigPair(dir);
    const expectedBytes = Buffer.from(formatHarnessConfigJson(config), "utf8");
    expect(pair.fingerprint).toBe(fingerprintHarnessConfigBytes(expectedBytes));
    expect(pair.encodedValue).toBe(expectedBytes.toString("base64"));
    expect(pair.bytes.equals(expectedBytes)).toBe(true);
  });

  it("prints safe failure details for fingerprint/decode/association without secrets", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "canary-fail-"));
    await mkdir(path.join(dir, ".harness"), { recursive: true });
    await writeFile(
      path.join(dir, HARNESS_MANAGED_REPO_MARKER_FILE),
      managedMarkerJson(),
      "utf8",
    );

    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await runRunnerConfigCanary(dir, {
        GITHUB_ACTIONS: "true",
        HARNESS_CONFIG_JSON_B64: Buffer.from('{"version":1}', "utf8").toString(
          "base64",
        ),
        HARNESS_CONFIG_FINGERPRINT: "not-the-real-hash",
      });
      expect(result.ok).toBe(false);
      expect(result.expectedFingerprint).toBe("not-the-real-hash");
      expect(result.computedFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.configDecodingSucceeded).toBe(false);
      expect(result.associationResolutionSucceeded).toBe(false);
      const printed = writes.join("");
      expect(printed).toContain("expectedFingerprint");
      expect(printed).toContain("computedFingerprint");
      expect(printed).toContain("configDecodingSucceeded");
      expect(printed).toContain("associationResolutionSucceeded");
      // Never include secret payload or decoded config body.
      expect(printed).not.toMatch(/eyJ/); // raw base64 config payload
      expect(printed).not.toContain('"repos"');
      expect(printed).not.toContain(PORTFOLIO);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("passes when cloud config fingerprint, decode, and associations succeed without local config.local.json", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "canary-ok-"));
    await mkdir(path.join(dir, ".harness"), { recursive: true });
    await writeFile(
      path.join(dir, HARNESS_MANAGED_REPO_MARKER_FILE),
      managedMarkerJson(),
      "utf8",
    );

    const config = sampleConfig();
    const bytes = Buffer.from(formatHarnessConfigJson(config), "utf8");
    const b64 = bytes.toString("base64");
    const fingerprint = fingerprintHarnessConfigBytes(bytes);

    const result = await runRunnerConfigCanary(dir, {
      GITHUB_ACTIONS: "true",
      HARNESS_CONFIG_JSON_B64: b64,
      HARNESS_CONFIG_FINGERPRINT: fingerprint,
    });
    expect(result.ok).toBe(true);
    expect(result.cloudConfigValid).toBe(true);
    expect(result.configDecodingSucceeded).toBe(true);
    expect(result.associationResolutionSucceeded).toBe(true);
    expect(result.expectedFingerprint).toBe(fingerprint);
    expect(result.computedFingerprint).toBe(fingerprint);
    expect(result.targetRepos[0]?.id).toBe("portfolio");
  });

  it("matches canary runs by unique operation id after dispatch 204", () => {
    const operationId = "op-canary-1234";
    const name = buildCanaryRunName(operationId);
    expect(
      workflowRunMatchesCanaryOperationId(
        { name, displayTitle: name },
        operationId,
      ),
    ).toBe(true);
    expect(
      workflowRunMatchesCanaryOperationId(
        { name: "PDev runner config canary", displayTitle: "other" },
        operationId,
      ),
    ).toBe(false);
  });
});
