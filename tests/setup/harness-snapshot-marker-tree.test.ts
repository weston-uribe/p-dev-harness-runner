import { describe, expect, it } from "vitest";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "../../src/setup/harness-managed-repo-marker.js";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";
import {
  createMarkerCommit,
  createSnapshotCommit,
  provisionHarnessWorkspaceFromSnapshot,
  verifyProvisionedHarnessWorkspace,
} from "../../src/setup/harness-snapshot-provisioning.js";
import { rm } from "node:fs/promises";

describe("mock git marker tree", () => {
  it("retains snapshot files at marker HEAD", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
    });

    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "Harness workspace",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId: "op-marker-tree",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const readme = await provider.readRepositoryFileContent(
      "test-user",
      "p-dev-harness",
      "README.md",
      result.markerCommitSha,
    );
    expect(readme).toContain("p-dev harness workspace");

    const marker = await provider.readRepositoryFileContent(
      "test-user",
      "p-dev-harness",
      HARNESS_MANAGED_REPO_MARKER_FILE,
      result.markerCommitSha,
    );
    expect(marker).toContain("createdFromPackageSnapshot");

    const verification = await verifyProvisionedHarnessWorkspace({
      provider,
      repoSlug: result.fullName,
      repositoryId: result.repositoryId,
      manifest: fixture.manifest,
    });
    expect(verification).toEqual({ ok: true });

    await rm(fixture.packageRoot, { recursive: true, force: true });
  });
});
