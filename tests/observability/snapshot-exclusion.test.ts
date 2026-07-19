import { describe, expect, it } from "vitest";
import { isForbiddenSnapshotPath } from "../../src/p-dev/workspace-snapshot-policy.js";
import { OBSERVABILITY_LOCAL_FILE } from "../../src/observability/constants.js";

describe("observability snapshot exclusion", () => {
  it("forbids observability local state in embedded snapshots", () => {
    expect(isForbiddenSnapshotPath(OBSERVABILITY_LOCAL_FILE)).toBe(true);
  });
});
