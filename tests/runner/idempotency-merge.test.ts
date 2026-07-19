import { describe, expect, it } from "vitest";
import {
  assertMergeEligibleStatus,
  checkMergeIdempotency,
} from "../../src/runner/idempotency.js";
import { inferPhaseFromStatus } from "../../src/runner/phase-infer.js";
import { formatMergeComment } from "../../src/linear/comments.js";
import type { HarnessConfig } from "../../src/config/types.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: { merge: ["Ready to Merge"] },
    transitionalStatuses: {
      readyToMerge: "Ready to Merge",
      mergingInProgress: "Merging",
      mergedToDev: "Merged to Dev",
      mergedDeployed: "Merged / Deployed",
    },
  },
  repos: [
    {
      id: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
};

const prUrl = "https://github.com/owner/example-target-app/pull/4";

function mergeComment() {
  return formatMergeComment("done", {
    orchestratorMarker: config.orchestratorMarker,
    phase: "merge",
    runId: "merge-run",
    model: "composer-2.5",
    promptVersion: "merge@1",
    targetRepo: "https://github.com/owner/example-target-app",
    prUrl,
  });
}

describe("merge idempotency", () => {
  it("skips when merge marker exists and PR is merged", () => {
    const result = checkMergeIdempotency(
      config,
      { id: "1", identifier: "WES-13", status: "Ready to Merge", teamId: "t" },
      [{ id: "c1", body: mergeComment() }],
      prUrl,
      true,
      false,
    );
    expect(result.skip).toBe(true);
  });

  it("retries when merge marker exists but PR is still open", () => {
    const result = checkMergeIdempotency(
      config,
      { id: "1", identifier: "WES-13", status: "Ready to Merge", teamId: "t" },
      [{ id: "c1", body: mergeComment() }],
      prUrl,
      false,
      false,
    );
    expect(result.skip).toBe(false);
    expect(result.reason).toContain("recovery");
  });

  it("allows recovery when PR merged without marker", () => {
    const result = checkMergeIdempotency(
      config,
      { id: "1", identifier: "WES-13", status: "Merging", teamId: "t" },
      [],
      prUrl,
      true,
      false,
    );
    expect(result.skip).toBe(false);
    expect(result.reason).toContain("recovery");
  });

  it("skips when issue is already Merged to Dev", () => {
    const result = checkMergeIdempotency(
      config,
      { id: "1", identifier: "WES-13", status: "Merged to Dev", teamId: "t" },
      [],
      prUrl,
      true,
      false,
    );
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("duplicate_phase_completed");
  });

  it("asserts Ready to Merge status", () => {
    expect(() =>
      assertMergeEligibleStatus(
        config,
        { id: "1", identifier: "WES-13", status: "PM Review", teamId: "t" },
        false,
      ),
    ).toThrow(/wrong_status/);
  });
});

describe("inferPhaseFromStatus merge routing", () => {
  it("routes Ready to Merge to merge", () => {
    expect(inferPhaseFromStatus("Ready to Merge", config).phase).toBe("merge");
  });

  it("does not route PM Review", () => {
    expect(inferPhaseFromStatus("PM Review", config).phase).toBe("none");
  });
});
