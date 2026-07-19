import { describe, expect, it } from "vitest";
import { formatPlanningComment } from "../../src/linear/comments.js";
import { parseHarnessMarkers } from "../../src/linear/markers.js";
import { hashPlanArtifactBody } from "../../src/workflow/plan-artifact.js";
import {
  extractFullPlanBody,
  recoverPlanArtifactFromPlanningComments,
} from "../../src/workflow/recover-plan-artifact.js";

const ORCHESTRATOR = "harness-orchestrator-v1";
const PLAN_BODY = [
  "## Scope",
  "Add a small portfolio tweak.",
  "",
  "## Steps",
  "1. Edit the page",
  "2. Verify locally",
].join("\n");

describe("recoverPlanArtifactFromPlanningComments", () => {
  it("recovers identity from marker-backed planning comments", () => {
    const comment = formatPlanningComment(PLAN_BODY, {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-run-marker",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
      planGenerationId: "gen-abc-123",
      planArtifactHash: hashPlanArtifactBody(PLAN_BODY),
    });

    const recovered = recoverPlanArtifactFromPlanningComments({
      comments: [{ body: comment, createdAt: "2026-07-18T00:00:00.000Z" }],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(recovered).not.toBeNull();
    expect(recovered?.planGenerationId).toBe("gen-abc-123");
    expect(recovered?.planArtifactHash).toBe(hashPlanArtifactBody(PLAN_BODY));
    expect(recovered?.plannerRunId).toBe("planning-run-marker");
    expect(recovered?.promptContractVersion).toBe("planning@1");
    expect(parseHarnessMarkers(comment).planGenerationId).toBe("gen-abc-123");
  });

  it("derives stable identity when markers lack plan_generation_id (legacy comments)", () => {
    const comment = formatPlanningComment(PLAN_BODY, {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-run-legacy",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
    });

    expect(parseHarnessMarkers(comment).planGenerationId).toBeUndefined();
    expect(extractFullPlanBody(comment)).toBe(PLAN_BODY);

    const first = recoverPlanArtifactFromPlanningComments({
      comments: [{ body: comment }],
      orchestratorMarker: ORCHESTRATOR,
    });
    const second = recoverPlanArtifactFromPlanningComments({
      comments: [{ body: comment }],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(first).not.toBeNull();
    expect(first?.planGenerationId).toMatch(/^plan-recovered-/);
    expect(first?.planGenerationId).toBe(second?.planGenerationId);
    expect(first?.planArtifactHash).toBe(hashPlanArtifactBody(PLAN_BODY));
    expect(first?.plannerRunId).toBe("planning-run-legacy");
  });

  it("prefers the newest planning completion comment (newest-first list)", () => {
    const older = formatPlanningComment("old plan body", {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-old",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
      planGenerationId: "gen-old",
      planArtifactHash: hashPlanArtifactBody("old plan body"),
    });
    const newer = formatPlanningComment(PLAN_BODY, {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-new",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
      planGenerationId: "gen-new",
      planArtifactHash: hashPlanArtifactBody(PLAN_BODY),
    });

    const recovered = recoverPlanArtifactFromPlanningComments({
      // Linear-style newest-first ordering
      comments: [
        { body: newer, createdAt: "2026-07-19T03:17:47.000Z" },
        { body: older, createdAt: "2026-07-19T02:45:42.000Z" },
      ],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(recovered?.planGenerationId).toBe("gen-new");
    expect(recovered?.plannerRunId).toBe("planning-new");
  });

  it("prefers marker-backed planning comments over older recovered stubs", () => {
    const legacy = formatPlanningComment("old stub plan", {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-legacy",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
    });
    const marked = formatPlanningComment(PLAN_BODY, {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "planning-marked",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
      planGenerationId: "gen-marked",
      planArtifactHash: hashPlanArtifactBody(PLAN_BODY),
    });

    const recovered = recoverPlanArtifactFromPlanningComments({
      comments: [
        { body: marked, createdAt: "2026-07-19T03:17:47.000Z" },
        { body: legacy, createdAt: "2026-07-19T02:45:42.000Z" },
      ],
      orchestratorMarker: ORCHESTRATOR,
    });

    expect(recovered?.planGenerationId).toBe("gen-marked");
  });

  it("returns null when no planning completion comment exists", () => {
    const recovered = recoverPlanArtifactFromPlanningComments({
      comments: [
        {
          body: "unrelated note\n\n<!--\nharness-orchestrator-v1\nphase: handoff\nrun_id: x\nmodel: m\nprompt_version: p\ntarget_repo: r\n-->",
        },
      ],
      orchestratorMarker: ORCHESTRATOR,
    });
    expect(recovered).toBeNull();
  });
});
