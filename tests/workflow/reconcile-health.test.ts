import { describe, expect, it } from "vitest";
import {
  AUTOMATED_PHASE_STALE_BLOCKED_MS,
  AUTOMATED_PHASE_STALE_WARNING_MS,
  buildReconcileHeartbeat,
  evaluateAutomatedPhaseStaleness,
  evaluateReconcileHeartbeatHealth,
  inspectReconcileWorkflowSource,
  parseReconcileHeartbeat,
  RECONCILE_HEARTBEAT_STALE_MS,
  RECONCILE_WORKFLOW_REQUIRED_COMMAND,
  RECONCILE_WORKFLOW_REQUIRED_CRON,
} from "../../src/workflow/reconcile-health.js";
import { createEmptyWorkflowState } from "../../src/workflow/state/index.js";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("reconcile health", () => {
  it("managed runner workflow source declares schedule and reconcile command", () => {
    const content = readFileSync(
      path.join(
        process.cwd(),
        ".github/workflows/harness-reconcile-revisions.yml",
      ),
      "utf8",
    );
    const inspected = inspectReconcileWorkflowSource(content);
    expect(inspected.hasSchedule).toBe(true);
    expect(inspected.hasRequiredCron).toBe(true);
    expect(inspected.invokesReconcileCommand).toBe(true);
    expect(content).toContain(RECONCILE_WORKFLOW_REQUIRED_CRON);
    expect(content).toContain(RECONCILE_WORKFLOW_REQUIRED_COMMAND);
  });

  it("heartbeat stale/missing evaluation", () => {
    expect(evaluateReconcileHeartbeatHealth(null).ok).toBe(false);
    const fresh = buildReconcileHeartbeat({
      candidatesFound: 1,
      opaqueDispatches: 1,
      statusesScanned: ["Plan Review"],
      finishedAt: new Date().toISOString(),
    });
    expect(parseReconcileHeartbeat(fresh)?.kind).toBe(
      "p-dev.reconcile-heartbeat.v1",
    );
    expect(evaluateReconcileHeartbeatHealth(fresh).ok).toBe(true);

    const stale = buildReconcileHeartbeat({
      candidatesFound: 0,
      opaqueDispatches: 0,
      statusesScanned: [],
      finishedAt: new Date(
        Date.now() - RECONCILE_HEARTBEAT_STALE_MS - 60_000,
      ).toISOString(),
    });
    const health = evaluateReconcileHeartbeatHealth(stale);
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.reason).toBe("stale");
    }
  });

  it("stale active plan_review phase becomes visible without webhook", () => {
    const base = createEmptyWorkflowState({
      issueKey: "FRE-6",
      workflowSchemaVersion: "product-development-v2",
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    const state = {
      ...base,
      currentPhaseId: "plan_review" as const,
      lastTransitionAt: new Date(
        Date.now() - AUTOMATED_PHASE_STALE_WARNING_MS - 1_000,
      ).toISOString(),
      latestPlanArtifact: {
        planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
        planArtifactHash:
          "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
        plannerRunId: "2026-07-21T00-14-47-057Z-FRE-6",
        promptContractVersion: "planning@1",
        workflowStateRevision: 1,
        createdAt: "2026-07-21T00:18:59.522Z",
        supersedesPlanGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
    };
    const warning = evaluateAutomatedPhaseStaleness({ state });
    expect(warning.level).toBe("warning");

    const blockedState = {
      ...state,
      lastTransitionAt: new Date(
        Date.now() - AUTOMATED_PHASE_STALE_BLOCKED_MS - 1_000,
      ).toISOString(),
    };
    expect(evaluateAutomatedPhaseStaleness({ state: blockedState }).level).toBe(
      "blocked_candidate",
    );
  });
});
