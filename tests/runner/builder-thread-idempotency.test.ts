import { describe, expect, it } from "vitest";
import {
  buildImplementationIdempotencyKey,
  buildIntegrationRepairIdempotencyKey,
  buildRevisionIdempotencyKey,
} from "../../src/runner/builder-thread-idempotency.js";

describe("builder thread idempotency keys", () => {
  it("builds stable implementation keys from issue and branch lineage", () => {
    const key = buildImplementationIdempotencyKey({
      issueKey: "WES-13",
      targetRepo: "https://github.com/owner/example-target-app",
      branch: "cursor/wes-13-test",
    });
    expect(key).toBe(
      "p-dev:build:WES-13:https://github.com/owner/example-target-app:cursor/wes-13-test",
    );
  });

  it("builds revision keys from PM feedback comment id", () => {
    expect(
      buildRevisionIdempotencyKey({
        issueKey: "WES-13",
        pmFeedbackCommentId: "feedback-abc",
      }),
    ).toBe("p-dev:revision:WES-13:feedback-abc");
  });

  it("builds integration repair keys from PR and SHAs", () => {
    expect(
      buildIntegrationRepairIdempotencyKey({
        issueKey: "WES-13",
        prUrl: "https://github.com/owner/example-target-app/pull/4",
        repairCycleId: "cycle-1",
        baseHeadSha: "base-sha",
        headSha: "head-sha",
      }),
    ).toBe(
      "p-dev:repair:WES-13:https://github.com/owner/example-target-app/pull/4:cycle-1:base-sha:head-sha",
    );
  });
});
