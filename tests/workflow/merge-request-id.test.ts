import { describe, expect, it } from "vitest";
import {
  buildMergeRequestSubject,
  resolveMergeJobRequestId,
} from "../../src/workflow/job-request/merge-request-id.js";

describe("merge request identity", () => {
  const base = {
    issueKey: "FRE-5",
    targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
    prNumber: 50,
    reviewedHeadSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
    approvedReviewDecisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
  };

  it("normalizes repository and is stable across equivalent inputs", () => {
    const a = resolveMergeJobRequestId(base);
    const b = resolveMergeJobRequestId({
      ...base,
      issueKey: "fre-5",
      targetRepository: "weston-uribe/weston-uribe-portfolio.git",
      reviewedHeadSha: base.reviewedHeadSha.toUpperCase(),
    });
    expect(a).toMatch(/^mrg-[a-f0-9]{32}$/);
    expect(a).toBe(b);
    expect(buildMergeRequestSubject(base)).toContain("merge-request:FRE-5:");
  });

  it("changes when decision identity or head sha changes", () => {
    const a = resolveMergeJobRequestId(base);
    const b = resolveMergeJobRequestId({
      ...base,
      approvedReviewDecisionIdentity: "different-decision",
    });
    const c = resolveMergeJobRequestId({
      ...base,
      reviewedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
