import { describe, expect, it } from "vitest";
import { shouldAttemptMerge } from "../../src/setup/workflow-install-merge-gate.js";

describe("workflow-install-merge-gate", () => {
  it("attempts merge when mergeable_state is blocked but mergeable is true", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "blocked",
        mergeable: true,
      }),
    ).toBe(true);
  });

  it("attempts merge when mergeable_state is clean and mergeable is true", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "clean",
        mergeable: true,
      }),
    ).toBe(true);
  });

  it("does not attempt merge when mergeable is false", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "clean",
        mergeable: false,
      }),
    ).toBe(false);
  });

  it("does not attempt merge when mergeable_state is dirty", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "dirty",
        mergeable: true,
      }),
    ).toBe(false);
  });

  it("does not attempt merge when mergeability is unknown", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "unknown",
        mergeable: null,
      }),
    ).toBe(false);
  });

  it("does not attempt merge when branch is behind", () => {
    expect(
      shouldAttemptMerge({
        mergeableState: "behind",
        mergeable: true,
      }),
    ).toBe(false);
  });
});
