import { describe, expect, it } from "vitest";
import {
  deriveConnectedToExistingManagedWorkspace,
  deriveCreatedSnapshotBackedWorkspace,
} from "../../src/observability/provisioning-analytics.js";

describe("provisioning analytics derivation", () => {
  it("uses preview state for connected managed workspace semantics", () => {
    expect(
      deriveConnectedToExistingManagedWorkspace({
        persisted: true,
        previewState: "valid-existing-managed-repo",
      }),
    ).toBe(true);
    expect(
      deriveConnectedToExistingManagedWorkspace({
        persisted: true,
        previewState: "same-name-snapshot-only-with-pending",
      }),
    ).toBe(false);
  });

  it("does not treat resumed pending state as legacy workspace evidence", () => {
    expect(
      deriveCreatedSnapshotBackedWorkspace({
        persisted: true,
        applyState: "verified-and-persisted",
        preview: {
          willCreateRepository: false,
          state: "same-name-snapshot-only-with-pending",
        },
      }),
    ).toBe(true);
    expect(
      deriveConnectedToExistingManagedWorkspace({
        persisted: true,
        previewState: "same-name-snapshot-only-with-pending",
      }),
    ).toBe(false);
  });

  it("marks snapshot-backed workspace creation from absent repo previews", () => {
    expect(
      deriveCreatedSnapshotBackedWorkspace({
        persisted: true,
        applyState: "verified-and-persisted",
        preview: {
          willCreateRepository: true,
          state: "repo-absent",
        },
      }),
    ).toBe(true);
  });
});
