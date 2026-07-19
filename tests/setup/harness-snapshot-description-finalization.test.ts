import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import {
  applyHarnessRepoProvisioning,
  previewHarnessRepoProvisioning,
} from "../../src/setup/harness-repo-provisioning.js";
import { readHarnessProvisioningPendingState } from "../../src/setup/harness-provisioning-pending-state.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";

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

const provisioningMutationMethods = new Set([
  "createUserRepository",
  "createGitBlob",
  "createGitTree",
  "createGitCommit",
  "updateGitRef",
]);

describe("description finalization recovery", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.P_DEV_PACKAGE_VERSION = "0.3.0";
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    snapshotFixture.snapshotRoot = fixture.snapshotRoot;
    snapshotFixture.packageRoot = fixture.packageRoot;
    snapshotFixture.manifest = fixture.manifest;
    snapshotFixture.fingerprint = fixture.fingerprint;
    workspaceDir = await mkdtemp(path.join(tmpdir(), "p-dev-desc-finalize-"));
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      ["GITHUB_TOKEN=ghp_test_token", "HARNESS_CONFIG_PATH=.harness/config.local.json"].join(
        "\n",
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    delete process.env.P_DEV_RUNTIME_MODE;
    delete process.env.P_DEV_PACKAGE_VERSION;
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
    if (snapshotFixture.packageRoot) {
      await rm(snapshotFixture.packageRoot, { recursive: true, force: true });
    }
    snapshotFixture.manifest = null;
  });

  it("resumes description restoration without recreating git objects", async () => {
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      updateUserRepositoryDescriptionError: new Error("description update failed"),
      updateUserRepositoryDescriptionErrorsRemaining: 1,
    });

    const preview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      operationId: "op-desc-retry",
    });
    const failedApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: preview.fingerprint,
      operationId: preview.operationId,
    });
    expect(failedApply.state).toBe("marker-write-pending");
    expect(await readHarnessProvisioningPendingState(workspaceDir)).not.toBeNull();

    const callsAfterFailure = provider.calls.length;
    provider.clearProvisioningFaults();

    const resumePreview = await previewHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
    });
    const resumeApply = await applyHarnessRepoProvisioning({
      cwd: workspaceDir,
      provider,
      confirmed: true,
      fingerprint: resumePreview.fingerprint,
      operationId: resumePreview.operationId,
    });
    expect(resumeApply.state).toBe("verified-and-persisted");

    const newMutations = provider.calls
      .slice(callsAfterFailure)
      .filter((call) => provisioningMutationMethods.has(call.method));
    expect(newMutations).toHaveLength(0);
    expect(
      provider.calls
        .slice(callsAfterFailure)
        .filter((call) => call.method === "updateUserRepositoryDescription"),
    ).toHaveLength(1);
    expect(await readHarnessProvisioningPendingState(workspaceDir)).toBeNull();

    const env = await readFile(path.join(workspaceDir, ".env.local"), "utf8");
    expect(env).toContain("GITHUB_DISPATCH_REPOSITORY=test-user/p-dev-harness");
  });
});
