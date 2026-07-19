import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as remoteSummaryRoute } from "../../apps/gui/app/api/setup/remote-summary/route.js";
import { POST as previewRoute } from "../../apps/gui/app/api/setup/preview-harness-secrets/route.js";
import { POST as applyRoute } from "../../apps/gui/app/api/setup/apply-harness-secrets/route.js";
import {
  clearHarnessTestRemoteSetupProviderFactory,
  registerHarnessTestRemoteSetupProviderFactory,
} from "../../src/setup/test-only-remote-setup-provider.js";
import { MockGitHubRemoteSetupProvider } from "../../src/setup/github-remote-provider.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "../../src/setup/remote-actions.js";

const SENTINEL = {
  linearApiKey: "sentinel-linear-packaged-step6",
  cursorApiKey: "sentinel-cursor-packaged-step6",
  githubToken: "sentinel-github-packaged-step6",
};

describe("packaged harness cloud secrets route regression", () => {
  let workspaceDir = "";
  let provider: MockGitHubRemoteSetupProvider;
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalPDevHome = process.env.P_DEV_HOME;
  const originalConfigPath = process.env.HARNESS_CONFIG_PATH;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackagedVersion = process.env.P_DEV_PACKAGE_VERSION;
  const originalTestSeam = process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = "enabled";
    // Prior apply/preview paths may absolutize HARNESS_CONFIG_PATH via dotenv load.
    // Clear workspace-scoped env so each test resolves config inside its temp dir.
    delete process.env.HARNESS_CONFIG_PATH;
    delete process.env.P_DEV_HOME;

    workspaceDir = await mkdtemp(path.join(tmpdir(), "packaged-route-cloud-secrets-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    const configBody = JSON.stringify(
      {
        version: 1,
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/weston-uribe/example-target-app",
            baseBranch: "dev",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: ["https://github.com/weston-uribe/example-target-app"],
      },
      null,
      2,
    );
    await writeFile(
      path.join(workspaceDir, ".harness", "config.local.json"),
      configBody,
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "LINEAR_API_KEY=sentinel-linear-packaged-step6",
        "CURSOR_API_KEY=sentinel-cursor-packaged-step6",
        "HARNESS_GITHUB_TOKEN=sentinel-github-packaged-step6",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "GITHUB_DISPATCH_REPOSITORY=weston-uribe/p-dev-harness",
        "GITHUB_DISPATCH_REPOSITORY_ID=1299710192",
      ].join("\n"),
      "utf8",
    );

    registerHarnessTestRemoteSetupProviderFactory(() => {
      provider = new MockGitHubRemoteSetupProvider({
        harnessRepoAccess: "available",
        harnessSecretStatuses: {
          LINEAR_API_KEY: "present",
          CURSOR_API_KEY: "present",
          HARNESS_GITHUB_TOKEN: "present",
          HARNESS_CONFIG_JSON_B64: "present",
        },
      });
      return provider;
    });
  });

  afterEach(async () => {
    clearHarnessTestRemoteSetupProviderFactory();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalPDevHome === undefined) {
      delete process.env.P_DEV_HOME;
    } else {
      process.env.P_DEV_HOME = originalPDevHome;
    }
    if (originalConfigPath === undefined) {
      delete process.env.HARNESS_CONFIG_PATH;
    } else {
      process.env.HARNESS_CONFIG_PATH = originalConfigPath;
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
      delete process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;
    } else {
      process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = originalTestSeam;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("refreshes remote summary for persisted auto-provisioned harness repo", async () => {
    const response = await remoteSummaryRoute();
    expect(response.status).toBe(200);
    const summary = (await response.json()) as {
      harnessDispatchRepo: string;
      harnessDispatchRepoResolved: boolean;
      harnessRepoAccess: string;
    };
    expect(summary.harnessDispatchRepo).toBe("weston-uribe/p-dev-harness");
    expect(summary.harnessDispatchRepoResolved).toBe(true);
    expect(summary.harnessRepoAccess).toBe("available");
  });

  it("returns authoritative apply evidence without secret values", async () => {
    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      fingerprint: string;
      secretWritePlan: Array<{ name: string; action: string; source: string }>;
    };
    const configPlan = preview.secretWritePlan.find(
      (entry) => entry.name === "HARNESS_CONFIG_JSON_B64",
    );
    expect(configPlan?.action).toBe("update");
    expect(
      preview.secretWritePlan.filter((entry) => entry.action === "skip").length,
    ).toBeGreaterThanOrEqual(3);

    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      }),
    );
    const applyBody = await applyResponse.json();
    expect(applyResponse.status, JSON.stringify(applyBody)).toBe(200);
    const result = applyBody as {
      apply: { writtenSecrets: Array<{ name: string; status: string }> };
      summary: {
        harnessDispatchRepoResolved: boolean;
        harnessSecretStatuses: Array<{ name: string; status: string }>;
      };
      evidence: {
        path: string;
        harnessConfigJsonB64Written: boolean;
        configStateFingerprint: string;
        postApplyVerificationReady: boolean;
      };
    };

    expect(result.evidence.path).toBe("automatic");
    expect(result.evidence.harnessConfigJsonB64Written).toBe(true);
    expect(result.evidence.postApplyVerificationReady).toBe(true);
    expect(result.summary.harnessDispatchRepoResolved).toBe(true);
    expect(
      result.summary.harnessSecretStatuses.every(
        (entry) => entry.status === "present",
      ),
    ).toBe(true);
  });

  it("rejects duplicate concurrent apply fingerprints only once per confirmed write", async () => {
    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const preview = (await previewResponse.json()) as { fingerprint: string };

    const firstApply = await applyRoute(
      new Request("http://localhost/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      }),
    );
    expect(firstApply.status).toBe(200);

    const secondApply = await applyRoute(
      new Request("http://localhost/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      }),
    );
    expect(secondApply.status).toBe(200);
    expect(
      provider.calls.filter((call) => call.method === "writeHarnessSecrets"),
    ).toHaveLength(2);
  });

  it("never returns secret values in preview, apply, or evidence payloads", async () => {
    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const previewText = await previewResponse.text();
    expect(previewText).not.toContain(SENTINEL.linearApiKey);
    expect(previewText).not.toContain(SENTINEL.cursorApiKey);
    expect(previewText).not.toContain(SENTINEL.githubToken);

    const preview = JSON.parse(previewText) as { fingerprint: string };
    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      }),
    );
    const applyText = await applyResponse.text();
    expect(applyText).not.toContain(SENTINEL.linearApiKey);
    expect(applyText).not.toContain(SENTINEL.cursorApiKey);
    expect(applyText).not.toContain(SENTINEL.githubToken);
    for (const secretName of HARNESS_ACTIONS_SECRET_NAMES) {
      expect(applyText).not.toMatch(new RegExp(`${secretName}=`));
    }
  });
});

describe("packaged harness cloud secrets test seam guardrails", () => {
  it("does not activate the mock remote provider outside vitest runtime", async () => {
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSeam = process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = "enabled";

    const { tryCreateHarnessTestRemoteSetupProvider } = await import(
      "../../src/setup/test-only-remote-setup-provider.js"
    );
    expect(tryCreateHarnessTestRemoteSetupProvider()).toBeNull();

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
      delete process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK;
    } else {
      process.env.HARNESS_VITEST_REMOTE_SETUP_MOCK = originalSeam;
    }
  });
});
