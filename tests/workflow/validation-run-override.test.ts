import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  buildPhaseExecutionFreeze,
  evaluatePlanReviewReadiness,
} from "../../src/workflow/plan-review-readiness.js";
import { evaluateCodeReviewReadiness } from "../../src/workflow/code-review-readiness.js";
import {
  buildValidationRunCleanupReport,
  completeAllActiveValidationRuns,
  createValidationRunSnapshot,
  expireValidationRun,
  resolveIssueConfiguration,
} from "../../src/workflow/validation-run/index.js";

const readyPlanStatuses = [{ name: "Plan Review", type: "started" }];
const readyCodeStatuses = [
  { name: "Code Review", type: "started" },
  { name: "Code Revision", type: "started" },
];

function baseConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    linear: {
      teamId: "team-tt",
      teamKey: "TT",
    },
    repos: [
      {
        id: "app",
        targetRepo: "https://github.com/example/app",
        baseBranch: "dev",
        productionBranch: "main",
        linearAssociations: [
          {
            teamId: "team-tt",
            projectId: "proj-tt",
            teamKey: "TT",
          },
        ],
      },
    ],
    workflow: {
      schemaVersion: "product-development-v2",
      optionalPhases: { planReview: false, codeReview: false },
      cycleLimits: { planReview: 4, codeReview: 4 },
    },
  } as HarnessConfig;
}

describe("validation-run issue-scoped overrides", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function tempHome(): Promise<string> {
    cwd = await mkdtemp(path.join(tmpdir(), "pdev-validation-run-"));
    // Store expects `.harness/validation-runs` under cwd
    return cwd;
  }

  it("allowlisted issue receives Plan Review while defaults stay disabled", async () => {
    const home = await tempHome();
    const config = baseConfig();
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-100"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });

    const allowlisted = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-100",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(allowlisted.requestedEnabled).toBe(true);
    expect(allowlisted.effectiveEnabled).toBe(true);
    expect(allowlisted.configurationSource).toBe("validation_run_override");
    expect(allowlisted.validationRunId).toBeTruthy();

    // Shared defaults unchanged
    expect(config.workflow?.optionalPhases?.planReview).toBe(false);
  });

  it("different TT issue remains on the disabled default path", async () => {
    const home = await tempHome();
    const config = baseConfig();
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-100"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });

    const other = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-999",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(other.requestedEnabled).toBe(false);
    expect(other.effectiveEnabled).toBe(false);
    expect(other.configurationSource).toBe("default");
    expect(other.uiState).toBe("disabled");
  });

  it("plan-only and code-only synthetic configurations do not leak", async () => {
    const home = await tempHome();
    const config = baseConfig();
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-PLAN"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-CODE"],
      requestedOptionalPhases: { planReview: false, codeReview: true },
      workflowSchemaVersion: "product-development-v2",
    });

    const planIssuePlan = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-PLAN",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    const planIssueCode = await evaluateCodeReviewReadiness({
      config,
      linearStatuses: readyCodeStatuses,
      issueKey: "TT-PLAN",
      cwd: home,
      promptImplemented: true,
      revisionPromptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
      reviserModelConfigValid: true,
    });
    expect(planIssuePlan.requestedEnabled).toBe(true);
    expect(planIssueCode.requestedEnabled).toBe(false);

    const codeIssuePlan = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-CODE",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    const codeIssueCode = await evaluateCodeReviewReadiness({
      config,
      linearStatuses: readyCodeStatuses,
      issueKey: "TT-CODE",
      cwd: home,
      promptImplemented: true,
      revisionPromptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
      reviserModelConfigValid: true,
    });
    expect(codeIssuePlan.requestedEnabled).toBe(false);
    expect(codeIssueCode.requestedEnabled).toBe(true);
  });

  it("real dogfood issue can enable both without changing defaults", async () => {
    const home = await tempHome();
    const config = baseConfig();
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-DOGFOOD"],
      requestedOptionalPhases: { planReview: true, codeReview: true },
      workflowSchemaVersion: "product-development-v2",
    });

    const plan = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-DOGFOOD",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    const code = await evaluateCodeReviewReadiness({
      config,
      linearStatuses: readyCodeStatuses,
      issueKey: "TT-DOGFOOD",
      cwd: home,
      promptImplemented: true,
      revisionPromptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
      reviserModelConfigValid: true,
    });
    expect(plan.requestedEnabled).toBe(true);
    expect(code.requestedEnabled).toBe(true);
    expect(config.workflow?.optionalPhases).toEqual({
      planReview: false,
      codeReview: false,
    });
  });

  it("concurrent routing cannot cross-apply overrides", async () => {
    const home = await tempHome();
    await createValidationRunSnapshot({
      cwd: home,
      validationRunId: "run-a",
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-A"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });
    await createValidationRunSnapshot({
      cwd: home,
      validationRunId: "run-b",
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-B"],
      requestedOptionalPhases: { planReview: false, codeReview: true },
      workflowSchemaVersion: "product-development-v2",
    });

    const forA = await resolveIssueConfiguration({
      issueKey: "TT-A",
      cwd: home,
      workflowSchemaVersion: "product-development-v2",
      linearTeamId: "team-tt",
    });
    const forB = await resolveIssueConfiguration({
      issueKey: "TT-B",
      cwd: home,
      workflowSchemaVersion: "product-development-v2",
      linearTeamId: "team-tt",
    });
    expect(forA.applied && forA.validationRunId).toBe("run-a");
    expect(forB.applied && forB.validationRunId).toBe("run-b");
  });

  it("expired override cannot start a new reviewer", async () => {
    const home = await tempHome();
    const config = baseConfig();
    const snap = await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-EXP"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });
    await expireValidationRun(snap.validationRunId, home);

    const readiness = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-EXP",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(readiness.requestedEnabled).toBe(false);
    expect(readiness.effectiveEnabled).toBe(false);
    expect(readiness.configurationSource).toBe("default");
  });

  it("claimed execution continues under its frozen configuration", async () => {
    const home = await tempHome();
    const config = baseConfig();
    const snap = await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-FREEZE"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });
    const readiness = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-FREEZE",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    const freeze = buildPhaseExecutionFreeze({
      readiness,
      planReviewerModelId: "composer-2.5",
      planReviewerFast: false,
    });
    expect(freeze.validationRunId).toBe(snap.validationRunId);
    expect(freeze.effectiveEnabled).toBe(true);

    await expireValidationRun(snap.validationRunId, home);

    // New starts fail closed
    const afterExpire = await evaluatePlanReviewReadiness({
      config,
      linearStatuses: readyPlanStatuses,
      issueKey: "TT-FREEZE",
      cwd: home,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(afterExpire.requestedEnabled).toBe(false);

    // Already-claimed freeze still carries the prior effective decision
    expect(freeze.effectiveEnabled).toBe(true);
    expect(freeze.validationRunId).toBe(snap.validationRunId);
    expect(freeze.configurationSource).toBe("validation_run_override");
  });

  it("final cleanup reports zero active validation overrides", async () => {
    const home = await tempHome();
    await createValidationRunSnapshot({
      cwd: home,
      linearTeamId: "team-tt",
      linearProjectId: "proj-tt",
      allowedIssueIds: ["TT-CLEAN"],
      requestedOptionalPhases: { planReview: true, codeReview: false },
      workflowSchemaVersion: "product-development-v2",
    });
    const before = await buildValidationRunCleanupReport(home);
    expect(before.zeroActive).toBe(false);
    expect(before.activeCount).toBe(1);

    const after = await completeAllActiveValidationRuns(home);
    expect(after.zeroActive).toBe(true);
    expect(after.activeCount).toBe(0);
    expect(after.activeValidationRunIds).toEqual([]);
  });
});
