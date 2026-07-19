import { GET as getBootstrap } from "../../apps/gui/app/api/workflow/bootstrap/route.ts";
import { PUT as putModels } from "../../apps/gui/app/api/workflow/models/route.ts";
import { GET as legacyBootstrap } from "../../apps/gui/app/api/operations/bootstrap/route.ts";
import { PUT as legacyDraftPut } from "../../apps/gui/app/api/operations/draft/route.ts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/gui/lib/workflow-server.ts", () => ({
  loadWorkflowBootstrap: vi.fn(async () => ({
    sourceMode: "fixture",
    plannerSelection: { modelId: "composer-2.5", displayName: "Composer 2.5", parameters: [], source: "roleModels" },
    builderSelection: { modelId: "composer-2.5", displayName: "Composer 2.5", parameters: [], source: "roleModels" },
    configFingerprint: "abc123",
    modelCatalog: [],
    scopes: [],
    warnings: [],
    canonicalWorkflow: { healthState: "healthy", violations: [] },
  })),
  saveWorkflowModel: vi.fn(async () => ({
    saved: true,
    role: "planner",
    modelSelection: { id: "composer-2.5" },
    configFingerprint: "def456",
    localConfigUpdated: true,
    cloudConfigUpdated: true,
    savedAt: new Date().toISOString(),
  })),
  WorkflowModelSyncError: class WorkflowModelSyncError extends Error {},
}));

describe("workflow API routes", () => {
  it("returns trimmed bootstrap payload", async () => {
    const response = await getBootstrap(
      new Request("http://localhost/api/workflow/bootstrap?source=fixture&fixture=basic"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.configFingerprint).toBe("abc123");
    expect(payload.plannerSelection.modelId).toBe("composer-2.5");
    expect(payload.draftId).toBeUndefined();
  });

  it("accepts model save requests", async () => {
    const response = await putModels(
      new Request("http://localhost/api/workflow/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "planner",
          modelId: "composer-2.5",
          params: [{ id: "fast", value: "false" }],
          expectedConfigFingerprint: "abc123",
          sourceMode: "fixture",
          fixtureId: "branching-pr-review",
          scopeId: "harness-repo",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.saved).toBe(true);
    expect(payload.configFingerprint).toBe("def456");
  });

  it("redirects legacy operations bootstrap route", async () => {
    const response = await legacyBootstrap(
      new Request("http://localhost/api/operations/bootstrap?source=fixture"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/api/workflow/bootstrap");
  });

  it("retires legacy draft route", async () => {
    const response = await legacyDraftPut(
      new Request("http://localhost/api/operations/draft", { method: "PUT" }),
    );
    expect(response.status).toBe(410);
  });
});
