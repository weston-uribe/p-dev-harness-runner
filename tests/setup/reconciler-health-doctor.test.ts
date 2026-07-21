import { describe, expect, it } from "vitest";
import {
  evaluateReconcileHeartbeatHealth,
  inspectReconcileWorkflowSource,
  RECONCILE_WORKFLOW_RELATIVE_PATH,
} from "../../src/workflow/reconcile-health.js";
import { writeReconcileHeartbeat, loadReconcileHeartbeat } from "../../src/workflow/reconcile-heartbeat-store.js";
import { buildReconcileHeartbeat } from "../../src/workflow/reconcile-health.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

describe("reconciler health doctor signals", () => {
  it("reports missing reconciler workflow content", () => {
    const inspected = inspectReconcileWorkflowSource("");
    expect(inspected.hasSchedule).toBe(false);
    expect(inspected.invokesReconcileCommand).toBe(false);
  });

  it("repo workflow path matches doctor expectation", () => {
    expect(RECONCILE_WORKFLOW_RELATIVE_PATH).toBe(
      ".github/workflows/harness-reconcile-revisions.yml",
    );
    const content = readFileSync(
      path.join(process.cwd(), RECONCILE_WORKFLOW_RELATIVE_PATH),
      "utf8",
    );
    expect(inspectReconcileWorkflowSource(content).invokesReconcileCommand).toBe(
      true,
    );
  });

  it("local heartbeat write/load supports doctor freshness check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reconcile-hb-"));
    const heartbeat = buildReconcileHeartbeat({
      candidatesFound: 2,
      opaqueDispatches: 1,
      statusesScanned: ["Plan Review", "Code Review"],
    });
    const written = await writeReconcileHeartbeat({ heartbeat, localRoot: root });
    expect(written.mode).toBe("local");
    const raw = await readFile(written.path, "utf8");
    expect(raw).toContain("legacyDispatchForbidden");

    const loaded = await loadReconcileHeartbeat({ localRoot: root });
    expect(evaluateReconcileHeartbeatHealth(loaded).ok).toBe(true);
  });
});
