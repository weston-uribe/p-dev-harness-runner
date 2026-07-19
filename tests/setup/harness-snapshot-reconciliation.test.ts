import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import { provisionHarnessWorkspaceFromSnapshot } from "../../src/setup/harness-snapshot-provisioning.js";
import { buildProvisioningRepositoryDescription } from "../../src/setup/harness-snapshot-provisioning-helpers.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";

describe("repository creation reconciliation", () => {
  beforeEach(() => {
    process.env.HARNESS_SNAPSHOT_RECONCILE_ATTEMPTS = "3";
    process.env.HARNESS_SNAPSHOT_RECONCILE_DELAY_MS = "1";
  });

  afterEach(() => {
    delete process.env.HARNESS_SNAPSHOT_RECONCILE_ATTEMPTS;
    delete process.env.HARNESS_SNAPSHOT_RECONCILE_DELAY_MS;
  });

  it("reconciles after ambiguous create once repository becomes visible", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      createUserRepositoryAmbiguous: true,
      getRepositoryMetadataAttemptsBeforeVisible: 2,
    });

    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "Harness workspace",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId: "op-reconcile-poll",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(
      provider.calls.filter((call) => call.method === "createUserRepository"),
    ).toHaveLength(1);
    expect(result.repositoryId).toBeGreaterThan(0);

    await rm(fixture.packageRoot, { recursive: true, force: true });
  });

  it("rejects same-name repository with a different operation marker", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": {
          owner: "test-user",
          repo: "p-dev-harness",
          private: true,
          visibility: "private",
          isTemplate: false,
          defaultBranch: "main",
          description: buildProvisioningRepositoryDescription(
            "Harness workspace",
            "other-operation",
          ),
          permissions: { admin: true, maintain: true, push: true },
        },
      },
    });
    vi.spyOn(provider, "createUserRepository").mockRejectedValue(
      new GitHubApiError(422, "ambiguous"),
    );

    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "Harness workspace",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId: "op-reconcile-reject",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("repository-create-ambiguous");

    await rm(fixture.packageRoot, { recursive: true, force: true });
  });

  it("rejects public same-name repository during reconciliation", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const operationId = "op-public-reject";
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      repositories: {
        "test-user/p-dev-harness": {
          owner: "test-user",
          repo: "p-dev-harness",
          private: false,
          visibility: "public",
          isTemplate: false,
          defaultBranch: "main",
          description: buildProvisioningRepositoryDescription(
            "Harness workspace",
            operationId,
          ),
          permissions: { admin: true, maintain: true, push: true },
        },
      },
    });
    vi.spyOn(provider, "createUserRepository").mockRejectedValue(
      new GitHubApiError(422, "ambiguous"),
    );

    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "Harness workspace",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId,
    });
    expect(result.ok).toBe(false);

    await rm(fixture.packageRoot, { recursive: true, force: true });
  });
});
