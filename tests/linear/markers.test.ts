import { describe, expect, it } from "vitest";
import { parseHarnessMarkers, extractHarnessMetadataBlock } from "../../src/linear/markers.js";
import {
  formatHarnessCommentFooter,
  formatPlanningComment,
} from "../../src/linear/comments.js";
import { getVisibleCommentBody } from "../../src/linear/comment-card.js";
import { hasVisibleMachineMetadata } from "./comment-assertions.js";

describe("parseHarnessMarkers", () => {
  it("parses legacy visible harness marker footer", () => {
    const comment = `Planning complete.

---
harness-orchestrator-v1
phase: planning
run_id: 2026-07-06T20-30-00Z-WES-11
cursor_agent_id: bc-abc123
cursor_run_id: run-456
model: composer-2.5
prompt_version: planning@1
target_repo: https://github.com/owner/example-target-app
base_branch: dev
---`;

    const markers = parseHarnessMarkers(comment);

    expect(markers.orchestratorMarker).toBe("harness-orchestrator-v1");
    expect(markers.phase).toBe("planning");
    expect(markers.runId).toBe("2026-07-06T20-30-00Z-WES-11");
    expect(markers.cursorAgentId).toBe("bc-abc123");
    expect(markers.model).toBe("composer-2.5");
    expect(markers.baseBranch).toBe("dev");
  });

  it("parses hidden HTML-comment harness metadata", () => {
    const comment = `# Comment from harness

**Phase:** Planning complete

## For the PM

Planning is complete.

<!--
harness-orchestrator-v1
phase: planning
run_id: run-hidden-1
model: composer-2.5
prompt_version: planning@1
target_repo: https://github.com/example/repo
-->`;

    const markers = parseHarnessMarkers(comment);

    expect(markers.orchestratorMarker).toBe("harness-orchestrator-v1");
    expect(markers.phase).toBe("planning");
    expect(markers.runId).toBe("run-hidden-1");
    expect(getVisibleCommentBody(comment)).not.toContain("harness-orchestrator-v1");
    expect(getVisibleCommentBody(comment)).not.toMatch(/^phase:\s/m);
  });

  it("extractHarnessMetadataBlock finds harness metadata in HTML comments", () => {
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "test",
      runId: "test-run",
      model: "composer-2.5",
      promptVersion: "test@1",
      targetRepo: "https://github.com/example/repo",
    });

    const block = extractHarnessMetadataBlock(`Visible body\n\n${footer}`);
    expect(block).toContain("phase: test");
    expect(block).toContain("run_id: test-run");
    expect(footer.startsWith("<!--")).toBe(true);
  });

  it("formatHarnessCommentFooter wraps metadata in HTML comments", () => {
    const body = formatPlanningComment("Plan step", {
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "planning",
      runId: "run-1",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
    });

    expect(body).toContain("<!--");
    expect(body).toContain("phase: planning");
    expect(hasVisibleMachineMetadata(body)).toBe(false);
    expect(parseHarnessMarkers(body).phase).toBe("planning");
  });

  // Linear preserves HTML comments in stored comment bodies (verified via API round-trip).
  // Hidden metadata strategy depends on this behavior.

  it("round-trips Builder thread metadata fields", () => {
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "revision_start",
      runId: "rev-run-1",
      model: "composer-2.5",
      promptVersion: "revision@1",
      targetRepo: "https://github.com/owner/example-target-app",
      builderAgentId: "bc-builder-1",
      builderThreadGeneration: 2,
      builderThreadAction: "resumed",
      builderOriginRunId: "impl-run-1",
      builderThreadIdempotencyKey: "p-dev:revision:WES-1:comment-1",
      previousBuilderAgentId: "bc-builder-0",
      builderThreadReplacementReason: "agent_not_found",
    });

    const markers = parseHarnessMarkers(`Revision starting.\n\n${footer}`);
    expect(markers.builderAgentId).toBe("bc-builder-1");
    expect(markers.builderThreadGeneration).toBe("2");
    expect(markers.builderThreadAction).toBe("resumed");
    expect(markers.builderOriginRunId).toBe("impl-run-1");
    expect(markers.builderThreadIdempotencyKey).toBe(
      "p-dev:revision:WES-1:comment-1",
    );
    expect(markers.previousBuilderAgentId).toBe("bc-builder-0");
    expect(markers.builderThreadReplacementReason).toBe("agent_not_found");
  });
});
