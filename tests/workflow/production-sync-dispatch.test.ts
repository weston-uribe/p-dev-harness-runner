import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  SyncDispatchError,
  validateProductionSyncDispatch,
} from "../../src/workflow/production-sync-dispatch.js";

function privateTargetConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "real-target",
        linearProjects: ["Private Target"],
        targetRepo: "https://github.com/owner/private-target",
        baseBranch: "dev",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/private-target"],
  };
}

describe("validateProductionSyncDispatch", () => {
  it("accepts valid dispatch context for configured repo", () => {
    expect(() =>
      validateProductionSyncDispatch(
        {
          repoId: "real-target",
          sourceRepo: "owner/private-target",
          productionBranch: "main",
          ref: "refs/heads/main",
        },
        privateTargetConfig(),
      ),
    ).not.toThrow();
  });

  it("rejects unknown repo id", () => {
    expect(() =>
      validateProductionSyncDispatch(
        { repoId: "missing-target" },
        privateTargetConfig(),
      ),
    ).toThrow(SyncDispatchError);

    expect(() =>
      validateProductionSyncDispatch(
        { repoId: "missing-target" },
        privateTargetConfig(),
      ),
    ).toThrow(/unknown_repo_id/);
  });

  it("rejects sourceRepo mismatch", () => {
    expect(() =>
      validateProductionSyncDispatch(
        {
          repoId: "real-target",
          sourceRepo: "owner/wrong-target",
        },
        privateTargetConfig(),
      ),
    ).toThrow(/source_repo_mismatch/);
  });

  it("rejects productionBranch mismatch", () => {
    expect(() =>
      validateProductionSyncDispatch(
        {
          repoId: "real-target",
          productionBranch: "production",
        },
        privateTargetConfig(),
      ),
    ).toThrow(/production_branch_mismatch/);
  });

  it("rejects ref mismatch", () => {
    expect(() =>
      validateProductionSyncDispatch(
        {
          repoId: "real-target",
          ref: "refs/heads/dev",
        },
        privateTargetConfig(),
      ),
    ).toThrow(/ref_mismatch/);
  });

  it("accepts repo id only when dispatch metadata omitted", () => {
    expect(() =>
      validateProductionSyncDispatch(
        { repoId: "real-target" },
        privateTargetConfig(),
      ),
    ).not.toThrow();
  });
});
