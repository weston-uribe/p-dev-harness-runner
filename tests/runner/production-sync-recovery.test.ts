import { describe, expect, it } from "vitest";
import {
  buildProductionCompletionId,
  createProductionCompletionRecord,
  isProductionEffectCompleted,
  upsertProductionEffect,
  withProductionState,
} from "../../src/workflow/state/production-completion.js";

const PROMOTION_SHA = "201c4461d2aa439fd47890e3213b3679ae4150fb";
const DEPLOYMENT_ID = "dpl_4nVwECz27HcHZafsKXTNihUTpks1";
const TARGET =
  "https://github.com/weston-uribe/weston-uribe-portfolio";

const ISSUES = [
  { key: "FRE-6", mergeToDevSha: "0d86f7dda983aaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { key: "FRE-7", mergeToDevSha: "7955b7798073aaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { key: "FRE-8", mergeToDevSha: "f10d3b8cb74eaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { key: "FRE-9", mergeToDevSha: "8d73e0d8a29faaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
] as const;

function blockedVercelMissingCompletion(input: {
  key: string;
  mergeToDevSha: string;
}) {
  let record = createProductionCompletionRecord({
    issueKey: input.key,
    targetRepository: TARGET,
    mergeToDevSha: input.mergeToDevSha,
    productionBranch: "main",
  });
  record = withProductionState(record, "promotion_proven", {
    firstProductionHeadContainingMerge: PROMOTION_SHA,
    promotionSha: PROMOTION_SHA,
  });
  record = upsertProductionEffect(record, "langfuse_promoted_to_main", "completed");
  record = withProductionState(record, "blocked", {
    blockedReason: "vercel_token_missing",
  });
  return record;
}

describe("production-sync recovery / idempotency", () => {
  it("reuses stable completion IDs and promotion SHA when resuming vercel_token_missing", () => {
    for (const issue of ISSUES) {
      const blocked = blockedVercelMissingCompletion(issue);
      const expectedId = buildProductionCompletionId({
        issueKey: issue.key,
        targetRepository: TARGET,
        mergeToDevSha: issue.mergeToDevSha,
        productionBranch: "main",
      });
      expect(blocked.productionCompletionId).toBe(expectedId);
      expect(blocked.evidence.promotionSha).toBe(PROMOTION_SHA);
      expect(blocked.evidence.blockedReason).toBe("vercel_token_missing");
      expect(
        isProductionEffectCompleted(blocked, "langfuse_promoted_to_main"),
      ).toBe(true);

      // Resume after token appears: same identity + promotion SHA.
      let resumed = withProductionState(blocked, "deployment_verified", {
        deploymentId: DEPLOYMENT_ID,
        deploymentSha: PROMOTION_SHA,
        aliasSha: PROMOTION_SHA,
        blockedReason: undefined,
      });
      const revisionBeforeLangfuse = resumed.stateRevision;
      resumed = upsertProductionEffect(
        resumed,
        "langfuse_promoted_to_main",
        "pending",
      );
      expect(resumed.stateRevision).toBe(revisionBeforeLangfuse);
      expect(resumed.productionCompletionId).toBe(expectedId);
      expect(resumed.evidence.deploymentId).toBe(DEPLOYMENT_ID);
      expect(resumed.evidence.deploymentSha).toBe(PROMOTION_SHA);
    }
  });


  it("keeps four issues independent — one failure does not roll back others", () => {
    const records = ISSUES.map((issue) => blockedVercelMissingCompletion(issue));
    const ids = new Set(records.map((record) => record.productionCompletionId));
    expect(ids.size).toBe(4);

    const failed = withProductionState(records[0]!, "blocked", {
      blockedReason: "deployment_sha_mismatch",
      deploymentId: "dpl_other",
      deploymentSha: "deadbeef",
    });
    const advanced = records.slice(1).map((record) =>
      withProductionState(record, "completed", {
        deploymentId: DEPLOYMENT_ID,
        deploymentSha: PROMOTION_SHA,
        aliasSha: PROMOTION_SHA,
      }),
    );

    expect(failed.state).toBe("blocked");
    expect(failed.evidence.blockedReason).toBe("deployment_sha_mismatch");
    for (const record of advanced) {
      expect(record.state).toBe("completed");
      expect(record.evidence.deploymentId).toBe(DEPLOYMENT_ID);
      expect(record.evidence.deploymentSha).toBe(PROMOTION_SHA);
    }
  });

  it("accepts READY deploy evidence for the exact promotion SHA and rejects mismatch", () => {
    const base = blockedVercelMissingCompletion(ISSUES[0]!);
    const ready = withProductionState(base, "deployment_verified", {
      deploymentId: DEPLOYMENT_ID,
      deploymentSha: PROMOTION_SHA,
      aliasSha: PROMOTION_SHA,
    });
    expect(ready.evidence.deploymentSha).toBe(PROMOTION_SHA);
    expect(ready.evidence.deploymentId).toBe(DEPLOYMENT_ID);

    const mismatch = withProductionState(base, "blocked", {
      blockedReason: "deployment_sha_mismatch",
      deploymentId: DEPLOYMENT_ID,
      deploymentSha: "ffffffffffffffffffffffffffffffffffffffff",
    });
    expect(mismatch.state).toBe("blocked");
    expect(mismatch.evidence.deploymentSha).not.toBe(PROMOTION_SHA);
  });

  it("second reconcile is effect-level no-op once terminal effects are completed", () => {
    let record = blockedVercelMissingCompletion(ISSUES[1]!);
    record = withProductionState(record, "completed", {
      deploymentId: DEPLOYMENT_ID,
      deploymentSha: PROMOTION_SHA,
      aliasSha: PROMOTION_SHA,
    });
    for (const kind of [
      "langfuse_promoted_to_main",
      "langfuse_production_deployment_started",
      "langfuse_production_deployment_ready",
      "langfuse_production_verified",
      "linear_production_comment",
      "linear_status_transition",
      "langfuse_delivery_outcome",
    ] as const) {
      record = upsertProductionEffect(record, kind, "completed");
    }

    const revision = record.stateRevision;
    const effectCount = record.effects.length;
    for (const kind of [
      "langfuse_promoted_to_main",
      "linear_status_transition",
      "langfuse_delivery_outcome",
    ] as const) {
      record = upsertProductionEffect(record, kind, "pending");
    }
    expect(record.stateRevision).toBe(revision);
    expect(record.effects).toHaveLength(effectCount);
    expect(
      record.effects.every((effect) => effect.status === "completed"),
    ).toBe(true);
  });
});
