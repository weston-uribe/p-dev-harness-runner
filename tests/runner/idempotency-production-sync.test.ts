import { describe, expect, it } from "vitest";
import {
  checkProductionSyncIdempotency,
  decideProductionSyncGate,
  isProductionSyncDurableComplete,
  REQUIRED_PRODUCTION_SYNC_EFFECTS,
} from "../../src/runner/idempotency.js";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  createProductionCompletionRecord,
  upsertProductionEffect,
  withProductionState,
} from "../../src/workflow/state/production-completion.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    transitionalStatuses: {
      mergedToDev: "Merged to Dev",
      mergedDeployed: "Merged / Deployed",
    },
  },
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      targetRepo: "https://github.com/o/r",
      baseBranch: "dev",
      productionBranch: "main",
      integrationSuccessStatus: "Merged to Dev",
      productionSuccessStatus: "Merged / Deployed",
    },
  ],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-1",
  title: "Test",
  description: "",
  status: "Merged to Dev",
  projectName: "Example Target App",
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

function fullyCompleteRecord() {
  let record = createProductionCompletionRecord({
    issueKey: "WES-1",
    targetRepository: "https://github.com/o/r",
    mergeToDevSha: "abc123",
    productionBranch: "main",
  });
  record = withProductionState(record, "completed");
  for (const kind of REQUIRED_PRODUCTION_SYNC_EFFECTS) {
    record = upsertProductionEffect(record, kind, "completed");
  }
  return record;
}

describe("production sync idempotency / gate", () => {
  it("no-ops only when production-success and durable completion is full", () => {
    const decision = decideProductionSyncGate({
      issueStatus: "Merged / Deployed",
      productionSuccessStatus: "Merged / Deployed",
      integrationSuccessStatus: "Merged to Dev",
      completion: fullyCompleteRecord(),
    });
    expect(decision.action).toBe("noop");
  });

  it("continues when marker would previously have skipped but durable work remains", () => {
    const decision = decideProductionSyncGate({
      issueStatus: "Merged to Dev",
      productionSuccessStatus: "Merged / Deployed",
      integrationSuccessStatus: "Merged to Dev",
      completion: createProductionCompletionRecord({
        issueKey: "WES-1",
        targetRepository: "https://github.com/o/r",
        mergeToDevSha: "abc123",
        productionBranch: "main",
      }),
    });
    expect(decision.action).toBe("continue");
  });

  it("continues when production-success but durable record incomplete", () => {
    const decision = decideProductionSyncGate({
      issueStatus: "Merged / Deployed",
      productionSuccessStatus: "Merged / Deployed",
      integrationSuccessStatus: "Merged to Dev",
      completion: createProductionCompletionRecord({
        issueKey: "WES-1",
        targetRepository: "https://github.com/o/r",
        mergeToDevSha: "abc123",
        productionBranch: "main",
      }),
    });
    expect(decision.action).toBe("continue");
  });

  it("fails unexpected status with wrong_status", () => {
    const decision = decideProductionSyncGate({
      issueStatus: "Backlog",
      productionSuccessStatus: "Merged / Deployed",
      integrationSuccessStatus: "Merged to Dev",
      completion: null,
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.classification).toBe("wrong_status");
    }
  });

  it("compat checkProductionSyncIdempotency does not skip on marker alone", () => {
    const result = checkProductionSyncIdempotency(
      config,
      issue,
      [
        {
          id: "c1",
          body: `---\nharness-orchestrator-v1\nphase: production_sync\nrun_id: sync-1\nmerge_commit_sha: abc123\n---`,
        },
      ],
      "abc123",
      "Merged / Deployed",
      "Merged to Dev",
    );
    expect(result.skip).toBe(false);
  });

  it("isProductionSyncDurableComplete requires all effects", () => {
    expect(isProductionSyncDurableComplete(fullyCompleteRecord())).toBe(true);
    expect(
      isProductionSyncDurableComplete(
        createProductionCompletionRecord({
          issueKey: "WES-1",
          targetRepository: "https://github.com/o/r",
          mergeToDevSha: "abc123",
          productionBranch: "main",
        }),
      ),
    ).toBe(false);
  });
});
