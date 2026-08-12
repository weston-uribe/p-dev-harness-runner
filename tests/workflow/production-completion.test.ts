import { describe, expect, it } from "vitest";
import {
  buildProductionCompletionId,
  buildProductionEffectId,
  createProductionCompletionRecord,
  isProductionEffectCompleted,
  upsertProductionEffect,
  withProductionState,
} from "../../src/workflow/state/production-completion.js";

describe("production completion identity and effects", () => {
  it("builds stable identity that ignores production head sha", () => {
    const a = buildProductionCompletionId({
      issueKey: "FRE-1",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "abc123",
      productionBranch: "main",
    });
    const b = buildProductionCompletionId({
      issueKey: "fre-1",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "ABC123",
      productionBranch: "main",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("stores evidence separately from identity", () => {
    let record = createProductionCompletionRecord({
      issueKey: "FRE-1",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "merge1",
      productionBranch: "main",
    });
    const identity = record.productionCompletionId;
    record = withProductionState(record, "promotion_proven", {
      firstProductionHeadContainingMerge: "head1",
      promotionSha: "head1",
    });
    record = withProductionState(record, "deployment_verified", {
      deploymentId: "dpl_1",
      deploymentSha: "head2",
      aliasSha: "head2",
    });
    expect(record.productionCompletionId).toBe(identity);
    expect(record.evidence.deploymentId).toBe("dpl_1");
    expect(record.evidence.firstProductionHeadContainingMerge).toBe("head1");
  });

  it("effect IDs are deterministic and idempotent on completed", () => {
    const record = createProductionCompletionRecord({
      issueKey: "FRE-3",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "m1",
      productionBranch: "main",
    });
    const id1 = buildProductionEffectId(
      record.productionCompletionId,
      "linear_production_comment",
    );
    const id2 = buildProductionEffectId(
      record.productionCompletionId,
      "linear_production_comment",
    );
    expect(id1).toBe(id2);

    let next = upsertProductionEffect(
      record,
      "linear_production_comment",
      "completed",
    );
    expect(isProductionEffectCompleted(next, "linear_production_comment")).toBe(
      true,
    );
    const revision = next.stateRevision;
    next = upsertProductionEffect(
      next,
      "linear_production_comment",
      "pending",
    );
    expect(next.stateRevision).toBe(revision);
    expect(isProductionEffectCompleted(next, "linear_production_comment")).toBe(
      true,
    );
  });

  it("sibling issues have independent completion identities", () => {
    const a = buildProductionCompletionId({
      issueKey: "FRE-1",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "sha-a",
      productionBranch: "main",
    });
    const b = buildProductionCompletionId({
      issueKey: "FRE-3",
      targetRepository: "https://github.com/owner/app",
      mergeToDevSha: "sha-b",
      productionBranch: "main",
    });
    expect(a).not.toBe(b);
  });
});
