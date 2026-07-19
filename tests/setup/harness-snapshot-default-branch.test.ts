import { describe, expect, it } from "vitest";
import { MockGitHubHarnessProvisioningProvider } from "../../src/setup/github-remote-provider.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";
import {
  provisionHarnessWorkspaceFromSnapshot,
  verifyPendingRepositoryIdentity,
} from "../../src/setup/harness-snapshot-provisioning.js";
import { buildTestSnapshotPendingState } from "./test-workspace-snapshot-fixture.js";
import { rm } from "node:fs/promises";

describe("snapshot provisioning default branch", () => {
  it("uses non-main default branch for ref updates and resume", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    const provider = new MockGitHubHarnessProvisioningProvider({
      authenticatedUser: { id: 1, login: "test-user" },
      createdRepositoryDefaultBranch: "master",
    });

    const result = await provisionHarnessWorkspaceFromSnapshot({
      provider,
      user: { id: 1, login: "test-user" },
      repoName: "p-dev-harness",
      description: "Harness workspace",
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      packageVersion: "0.3.0",
      operationId: "op-master-branch",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.defaultBranch).toBe("master");

    const refCalls = provider.calls.filter((call) => call.method === "updateGitRef");
    expect(refCalls.length).toBeGreaterThan(0);
    for (const call of refCalls) {
      expect((call.args[0] as { ref: string }).ref).toBe("master");
    }
    expect(provider.calls.some((call) => call.method === "updateGitRef" && (call.args[0] as { ref: string }).ref === "main")).toBe(false);

    const pending = buildTestSnapshotPendingState(fixture.manifest, {
      operationId: "op-master-branch",
      repositoryId: result.repositoryId,
      defaultBranch: "master",
      initializedCommitSha: result.initializedCommitSha,
      snapshotCommitSha: result.snapshotCommitSha,
      markerCommitSha: result.markerCommitSha,
      phase: "description-pending",
    });
    const identity = await verifyPendingRepositoryIdentity({
      provider,
      pending,
      manifest: fixture.manifest,
    });
    expect(identity).toEqual({ ok: true });

    const mismatchPending = buildTestSnapshotPendingState(fixture.manifest, {
      repositoryId: result.repositoryId,
      defaultBranch: "trunk",
      initializedCommitSha: result.initializedCommitSha,
      markerCommitSha: result.markerCommitSha,
    });
    const mismatch = await verifyPendingRepositoryIdentity({
      provider,
      pending: mismatchPending,
      manifest: fixture.manifest,
    });
    expect(mismatch.ok).toBe(false);

    await rm(fixture.packageRoot, { recursive: true, force: true });
  });
});
