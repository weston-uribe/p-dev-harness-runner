import { describe, expect, it } from "vitest";
import {
  buildReconcileHeartbeat,
  evaluateReconcileHeartbeatHealth,
  inspectReconcileWorkflowSource,
  RECONCILE_HEARTBEAT_STALE_MS,
  RECONCILE_WORKFLOW_REQUIRED_CRON,
} from "../../src/workflow/reconcile-health.js";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("reconcile heartbeat health", () => {
  it("builds heartbeat for success, zero candidates, and failure", () => {
    const success = buildReconcileHeartbeat({
      candidatesFound: 0,
      opaqueDispatches: 0,
      statusesScanned: ["Code Review"],
      dispatchEnabled: true,
      outcome: "success",
    });
    expect(success.candidatesFound).toBe(0);
    expect(success.outcome).toBe("success");
    expect(success.lastSuccessfulScanAt).toBe(success.finishedAt);
    expect(success.dispatchEnabled).toBe(true);

    const failure = buildReconcileHeartbeat({
      candidatesFound: 0,
      opaqueDispatches: 0,
      statusesScanned: ["Code Review"],
      dispatchEnabled: true,
      outcome: "failure",
      lastFailure: "boom",
      lastSuccessfulScanAt: null,
    });
    expect(failure.outcome).toBe("failure");
    expect(failure.lastFailure).toBe("boom");
    expect(failure.lastSuccessfulScanAt).toBeNull();
  });

  it("detects missing and stale heartbeats", () => {
    expect(evaluateReconcileHeartbeatHealth(null).ok).toBe(false);
    expect(evaluateReconcileHeartbeatHealth(null).reason).toBe("missing");

    const stale = buildReconcileHeartbeat({
      finishedAt: new Date(Date.now() - RECONCILE_HEARTBEAT_STALE_MS - 1000).toISOString(),
      candidatesFound: 1,
      opaqueDispatches: 0,
      statusesScanned: ["Code Review"],
      outcome: "success",
    });
    const health = evaluateReconcileHeartbeatHealth(stale);
    expect(health.ok).toBe(false);
    expect(health.reason).toBe("stale");
  });

  it("repo workflow declares required cron and reconcile command", () => {
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
    expect(content).toContain("cancel-in-progress: false");
  });
});
