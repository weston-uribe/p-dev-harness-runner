import { describe, expect, it } from "vitest";
import {
  buildPendingValidationContext,
  validatePendingProvisioningState,
  withHarnessProvisioningMutex,
} from "../../src/setup/harness-provisioning-pending-state.js";
import { buildTestSnapshotPendingState, buildTestWorkspaceSnapshotManifest } from "./test-workspace-snapshot-fixture.js";

describe("harness provisioning pending state", () => {
  it("serializes workspace mutex calls and releases afterward", async () => {
    const order: string[] = [];

    const first = withHarnessProvisioningMutex("/tmp/workspace-a", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return "first";
    });

    const second = withHarnessProvisioningMutex("/tmp/workspace-a", async () => {
      order.push("second-start");
      order.push("second-end");
      return "second";
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);

    let thirdStarted = false;
    await withHarnessProvisioningMutex("/tmp/workspace-a", async () => {
      thirdStarted = true;
    });
    expect(thirdStarted).toBe(true);
  });

  it("validates the full pending provisioning context strictly", () => {
    const manifest = buildTestWorkspaceSnapshotManifest("0.3.0");
    const pending = buildTestSnapshotPendingState(manifest, {
      operationId: "op-1",
      previewFingerprint: "creation-fingerprint",
    });

    const valid = validatePendingProvisioningState(
      pending,
      buildPendingValidationContext({
        operationId: "op-1",
        authenticatedUserId: 1,
        authenticatedLogin: "test-user",
        targetOwner: "test-user",
        targetRepo: "p-dev-harness",
        packageVersion: manifest.packageVersion,
        sourceCommit: manifest.sourceCommit,
        manifestSchemaVersion: manifest.schemaVersion,
        snapshotContentId: manifest.snapshotContentId,
        snapshotSha256: manifest.snapshotSha256,
        snapshotGitTreeSha1: manifest.gitRootTreeSha1,
        previewFingerprint: "creation-fingerprint",
      }),
    );
    expect(valid.ok).toBe(true);

    const wrongUser = validatePendingProvisioningState(
      pending,
      buildPendingValidationContext({
        operationId: "op-1",
        authenticatedUserId: 2,
        authenticatedLogin: "other-user",
        targetOwner: "test-user",
        targetRepo: "p-dev-harness",
        packageVersion: manifest.packageVersion,
        sourceCommit: manifest.sourceCommit,
        manifestSchemaVersion: manifest.schemaVersion,
        snapshotContentId: manifest.snapshotContentId,
        snapshotSha256: manifest.snapshotSha256,
        snapshotGitTreeSha1: manifest.gitRootTreeSha1,
        previewFingerprint: "creation-fingerprint",
      }),
    );
    expect(wrongUser.ok).toBe(false);
  });
});
