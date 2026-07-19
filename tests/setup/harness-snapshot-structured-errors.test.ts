import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import {
  applyHarnessRepoProvisioning,
  previewHarnessRepoProvisioning,
} from "../../src/setup/harness-repo-provisioning.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";
import { SnapshotProvisioningError } from "../../src/setup/harness-snapshot-provisioning-helpers.js";
import * as snapshotProvisioning from "../../src/setup/harness-snapshot-provisioning.js";

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

describe("structured provisioning recovery states", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    snapshotFixture.snapshotRoot = fixture.snapshotRoot;
    snapshotFixture.packageRoot = fixture.packageRoot;
    snapshotFixture.manifest = fixture.manifest;
    snapshotFixture.fingerprint = fixture.fingerprint;
    workspaceDir = await mkdtemp(path.join(tmpdir(), "p-dev-structured-err-"));
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      ["GITHUB_TOKEN=ghp_test_token", "HARNESS_CONFIG_PATH=.harness/config.local.json"].join(
        "\n",
      ),
      "utf8",
    );
  });

  beforeEach(() => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
  });

  afterEach(async () => {
    delete process.env.P_DEV_RUNTIME_MODE;
    delete process.env.P_DEV_PACKAGE_VERSION;
    vi.restoreAllMocks();
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
    if (snapshotFixture.packageRoot) {
      await rm(snapshotFixture.packageRoot, { recursive: true, force: true });
    }
    snapshotFixture.manifest = null;
  });

  it("maps marker-commit-failed code to marker-write-pending regardless of message wording", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });
    vi.spyOn(snapshotProvisioning, "provisionHarnessWorkspaceFromSnapshot").mockResolvedValue({
      ok: false,
      message: "totally unrelated human text without marker keyword",
      recoverable: true,
      code: "marker-commit-failed",
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-structured",
    });
    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(apply.state).toBe("marker-write-pending");
  });

  it("maps description-finalization-failed code to marker-write-pending", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });
    vi.spyOn(snapshotProvisioning, "provisionHarnessWorkspaceFromSnapshot").mockResolvedValue({
      ok: false,
      message: new SnapshotProvisioningError(
        "description-finalization-failed",
        "custom operator-facing copy",
        true,
      ).message,
      recoverable: true,
      code: "description-finalization-failed",
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-desc-code",
    });
    const apply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(apply.state).toBe("marker-write-pending");
  });
});
