import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as previewRoute } from "../../apps/gui/app/api/setup/preview-harness-repo-provisioning/route.js";
import { POST as applyRoute } from "../../apps/gui/app/api/setup/apply-harness-repo-provisioning/route.js";
import {
  clearHarnessTestProvisioningProviderFactory,
  registerHarnessTestProvisioningProviderFactory,
} from "../../src/setup/test-only-provisioning-provider.js";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import {
  createTestWorkspaceSnapshotRoot,
} from "../setup/test-workspace-snapshot-fixture.js";

const snapshotFixture = vi.hoisted(() => ({
  snapshotRoot: "",
  packageRoot: "",
  manifest: null as Awaited<
    ReturnType<typeof createTestWorkspaceSnapshotRoot>
  >["manifest"] | null,
  fingerprint: "",
}));

vi.mock("../../src/setup/harness-workspace-snapshot-loader.js", () => ({
  loadEmbeddedWorkspaceSnapshot: vi.fn(async () => {
    if (!snapshotFixture.manifest) {
      return {
        ok: false as const,
        state: "snapshot-unavailable" as const,
        message: "Test snapshot fixture is not initialized.",
      };
    }
    return {
      ok: true as const,
      packageRoot: snapshotFixture.packageRoot,
      snapshotRoot: snapshotFixture.snapshotRoot,
      packageVersion: "0.3.0",
      manifest: snapshotFixture.manifest,
      fingerprint: snapshotFixture.fingerprint,
    };
  }),
}));

describe("packaged harness provisioning route regression", () => {
  let workspaceDir = "";
  let snapshotTempDir = "";
  let provider: MockGitHubHarnessProvisioningProvider;
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackagedVersion = process.env.P_DEV_PACKAGE_VERSION;
  const originalTestSeam = process.env.HARNESS_VITEST_PROVISIONING_MOCK;

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    process.env.HARNESS_VITEST_PROVISIONING_MOCK = "enabled";

    workspaceDir = await mkdtemp(path.join(tmpdir(), "packaged-route-prov-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".harness", "config.example.json"),
      JSON.stringify({ version: 1, repos: [], allowedTargetRepos: [] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      ["GITHUB_TOKEN=ghp_test_token", "HARNESS_CONFIG_PATH=.harness/config.local.json"].join(
        "\n",
      ),
      "utf8",
    );

    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    snapshotTempDir = fixture.packageRoot;
    snapshotFixture.snapshotRoot = fixture.snapshotRoot;
    snapshotFixture.packageRoot = fixture.packageRoot;
    snapshotFixture.manifest = fixture.manifest;
    snapshotFixture.fingerprint = fixture.fingerprint;

    registerHarnessTestProvisioningProviderFactory(() => {
      provider = new MockGitHubHarnessProvisioningProvider({
        authenticatedUser: { id: 1, login: "test-user" },
      });
      return provider;
    });
  });

  afterEach(async () => {
    clearHarnessTestProvisioningProviderFactory();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalPackagedVersion === undefined) {
      delete process.env.P_DEV_PACKAGE_VERSION;
    } else {
      process.env.P_DEV_PACKAGE_VERSION = originalPackagedVersion;
    }
    if (originalTestSeam === undefined) {
      delete process.env.HARNESS_VITEST_PROVISIONING_MOCK;
    } else {
      process.env.HARNESS_VITEST_PROVISIONING_MOCK = originalTestSeam;
    }
    await rm(workspaceDir, { recursive: true, force: true });
    if (snapshotTempDir) {
      await rm(snapshotTempDir, { recursive: true, force: true });
      snapshotTempDir = "";
    }
    snapshotFixture.manifest = null;
  });

  it("accepts preview fingerprint through separate preview and apply routes once", async () => {
    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-harness-repo-provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: "op-route-packaged" }),
      }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      state: string;
      fingerprint: string;
      operationId: string;
      snapshotContentId: string | null;
      templateContentId: string | null;
    };
    expect(preview.state).toBe("repo-absent");
    const fingerprintPayload = JSON.parse(preview.fingerprint) as {
      pDevVersion: string;
      snapshotContentId: string;
    };
    expect(fingerprintPayload.pDevVersion).toBe("0.3.0");
    expect(preview.snapshotContentId).toBe(fingerprintPayload.snapshotContentId);
    expect(preview.templateContentId).toBe(preview.snapshotContentId);

    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-harness-repo-provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: preview.fingerprint,
          operationId: preview.operationId,
        }),
      }),
    );
    const applyBody = await applyResponse.json();
    expect(applyResponse.status, JSON.stringify(applyBody)).toBe(200);
    const apply = applyBody as {
      apply: { state: string; message: string };
    };
    expect(apply.apply.state).toBe("verified-and-persisted");
    expect(apply.apply.message).not.toContain(
      "Template metadata changed before apply",
    );
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(1);
    expect(
      provider.calls.filter((call) => call.method === "createRepositoryFromTemplate"),
    ).toHaveLength(0);
  });
});

describe("packaged harness provisioning test seam guardrails", () => {
  it("does not activate the mock provider outside vitest runtime", async () => {
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSeam = process.env.HARNESS_VITEST_PROVISIONING_MOCK;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    process.env.HARNESS_VITEST_PROVISIONING_MOCK = "enabled";

    const { tryCreateHarnessTestProvisioningProvider } = await import(
      "../../src/setup/test-only-provisioning-provider.js"
    );
    expect(tryCreateHarnessTestProvisioningProvider()).toBeNull();

    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalSeam === undefined) {
      delete process.env.HARNESS_VITEST_PROVISIONING_MOCK;
    } else {
      process.env.HARNESS_VITEST_PROVISIONING_MOCK = originalSeam;
    }
  });
});
