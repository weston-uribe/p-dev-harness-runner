import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as previewRoute } from "../../apps/gui/app/api/setup/preview-target-repo-provisioning/route.js";
import { POST as applyRoute } from "../../apps/gui/app/api/setup/apply-target-repo-provisioning/route.js";
import {
  clearTargetRepoTestProvisioningProviderFactory,
  registerTargetRepoTestProvisioningProviderFactory,
} from "../../src/setup/test-only-target-repo-provisioning-provider.js";
import { MockGitHubTargetRepositoryProvider } from "../../src/setup/github-target-repository-provider-mock.js";

describe("target repo provisioning routes", () => {
  let workspaceDir = "";
  let provider: MockGitHubTargetRepositoryProvider;
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalTestSeam = process.env.HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK;

  beforeEach(async () => {
    process.env.HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK = "enabled";
    workspaceDir = await mkdtemp(path.join(tmpdir(), "target-repo-route-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      ["GITHUB_TOKEN=ghp_test_token", "HARNESS_CONFIG_PATH=.harness/config.local.json"].join(
        "\n",
      ),
      "utf8",
    );
    provider = new MockGitHubTargetRepositoryProvider({
      authenticatedLogin: "test-user",
    });
    registerTargetRepoTestProvisioningProviderFactory(() => provider);
  });

  afterEach(async () => {
    clearTargetRepoTestProvisioningProviderFactory();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalTestSeam === undefined) {
      delete process.env.HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK;
    } else {
      process.env.HARNESS_VITEST_TARGET_REPO_PROVISIONING_MOCK = originalTestSeam;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns sanitized preview without secrets", async () => {
    const response = await previewRoute(
      new Request("http://localhost/api/setup/preview-target-repo-provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: "test-user",
          name: "route-product",
          visibility: "private",
        }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.state).toBe("preview-ready");
    expect(body.visibility).toBe("private");
    expect(JSON.stringify(body)).not.toContain("ghp_");
  });

  it("applies repository creation through the route", async () => {
    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-target-repo-provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: "test-user",
          name: "route-apply-product",
          visibility: "private",
        }),
      }),
    );
    const preview = await previewResponse.json();
    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-target-repo-provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: "test-user",
          name: "route-apply-product",
          visibility: "private",
          operationId: preview.operationId,
          creationActionId: preview.creationActionId,
          createdAt: preview.createdAt,
          fingerprint: preview.fingerprint,
          confirmed: true,
        }),
      }),
    );
    const apply = await applyResponse.json();
    expect(applyResponse.status).toBe(200);
    expect(apply.state).toBe("verified-complete");
    expect(apply.repositoryUrl).toContain("github.com/test-user/route-apply-product");
  });
});
