import { describe, expect, it } from "vitest";
import {
  HarnessMarkerParseError,
  parseHarnessMarkers,
  parseHarnessMarkersStrict,
  extractHarnessMetadataBlock,
} from "../../src/linear/markers.js";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";
import {
  formatHarnessCommentFooter,
  formatPlanningComment,
} from "../../src/linear/comments.js";
import {
  getVisibleCommentBody,
  hasVisibleMachineMetadata,
} from "./comment-assertions.js";

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
    const builderAgentId = "bc-builder-1";
    const previousBuilderAgentId = "bc-builder-0";
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "revision_start",
      runId: "rev-run-1",
      model: "composer-2.5",
      promptVersion: "revision@1",
      targetRepo: "https://github.com/owner/example-target-app",
      builderAgentIdHash: hashProviderIdentity(builderAgentId),
      builderThreadGeneration: 2,
      builderThreadAction: "resumed",
      builderOriginRunId: "impl-run-1",
      builderThreadIdempotencyKey: "p-dev:revision:WES-1:comment-1",
      previousBuilderAgentIdHash: hashProviderIdentity(previousBuilderAgentId),
      builderThreadReplacementReason: "agent_not_found",
    });

    const markers = parseHarnessMarkers(`Revision starting.\n\n${footer}`);
    expect(markers.builderAgentIdHash).toBe(hashProviderIdentity(builderAgentId));
    expect(markers.builderThreadGeneration).toBe("2");
    expect(markers.builderThreadAction).toBe("resumed");
    expect(markers.builderOriginRunId).toBe("impl-run-1");
    expect(markers.builderThreadIdempotencyKey).toBe(
      "p-dev:revision:WES-1:comment-1",
    );
    expect(markers.previousBuilderAgentIdHash).toBe(
      hashProviderIdentity(previousBuilderAgentId),
    );
    expect(markers.builderThreadReplacementReason).toBe("agent_not_found");
    expect(markers.builderAgentId).toBeUndefined();
    expect(markers.previousBuilderAgentId).toBeUndefined();
  });
});

function harnessMetadataBlock(lines: string[]): string {
  return `<!--
${lines.join("\n")}
-->`;
}

describe("parseHarnessMarkers identity hash markers", () => {
  const cursorAgentId = "bc-abc123";
  const cursorAgentIdHash = hashProviderIdentity(cursorAgentId);
  const cursorRunId = "run-456";
  const cursorRunIdHash = hashProviderIdentity(cursorRunId);
  const builderAgentId = "bc-builder-1";
  const builderAgentIdHash = hashProviderIdentity(builderAgentId);
  const previousBuilderAgentId = "bc-builder-0";
  const previousBuilderAgentIdHash = hashProviderIdentity(previousBuilderAgentId);

  it("parses legacy raw identity fields without hash markers", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      `cursor_agent_id: ${cursorAgentId}`,
      `cursor_run_id: ${cursorRunId}`,
      `builder_agent_id: ${builderAgentId}`,
      `previous_builder_agent_id: ${previousBuilderAgentId}`,
    ]);

    const markers = parseHarnessMarkers(comment);

    expect(markers.cursorAgentId).toBe(cursorAgentId);
    expect(markers.cursorRunId).toBe(cursorRunId);
    expect(markers.builderAgentId).toBe(builderAgentId);
    expect(markers.previousBuilderAgentId).toBe(previousBuilderAgentId);
    expect(markers.cursorAgentIdHash).toBeUndefined();
    expect(markers.cursorRunIdHash).toBeUndefined();
    expect(markers.builderAgentIdHash).toBeUndefined();
    expect(markers.previousBuilderAgentIdHash).toBeUndefined();
  });

  it("parses new hash identity fields", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      `cursor_agent_id_hash: ${cursorAgentIdHash}`,
      `cursor_run_id_hash: ${cursorRunIdHash}`,
      `builder_agent_id_hash: ${builderAgentIdHash}`,
      `previous_builder_agent_id_hash: ${previousBuilderAgentIdHash}`,
    ]);

    const markers = parseHarnessMarkersStrict(comment);

    expect(markers.cursorAgentIdHash).toBe(cursorAgentIdHash);
    expect(markers.cursorRunIdHash).toBe(cursorRunIdHash);
    expect(markers.builderAgentIdHash).toBe(builderAgentIdHash);
    expect(markers.previousBuilderAgentIdHash).toBe(previousBuilderAgentIdHash);
  });

  it("accepts consistent raw and hash identity pairs", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      `cursor_agent_id: ${cursorAgentId}`,
      `cursor_agent_id_hash: ${cursorAgentIdHash}`,
      `cursor_run_id: ${cursorRunId}`,
      `cursor_run_id_hash: ${cursorRunIdHash}`,
      `builder_agent_id: ${builderAgentId}`,
      `builder_agent_id_hash: ${builderAgentIdHash}`,
      `previous_builder_agent_id: ${previousBuilderAgentId}`,
      `previous_builder_agent_id_hash: ${previousBuilderAgentIdHash}`,
    ]);

    const markers = parseHarnessMarkers(comment);

    expect(markers.cursorAgentId).toBe(cursorAgentId);
    expect(markers.cursorAgentIdHash).toBe(cursorAgentIdHash);
    expect(markers.builderAgentIdHash).toBe(builderAgentIdHash);
  });

  it.each([
    ["uppercase", cursorAgentIdHash.toUpperCase()],
    ["mixed-case", `${cursorAgentIdHash.slice(0, 32)}${cursorAgentIdHash.slice(32).toUpperCase()}`],
    ["short", cursorAgentIdHash.slice(0, 63)],
    ["long", `${cursorAgentIdHash}a`],
    ["non-hex", `${"g".repeat(64)}`],
  ])("rejects malformed cursor_agent_id_hash (%s)", (_label, invalidHash) => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      `cursor_agent_id_hash: ${invalidHash}`,
    ]);

    expect(() => parseHarnessMarkers(comment)).toThrow(HarnessMarkerParseError);
    try {
      parseHarnessMarkers(comment);
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessMarkerParseError);
      expect((error as HarnessMarkerParseError).code).toBe("invalid_identity_hash_marker");
    }
  });

  it("rejects duplicate keys with conflicting values", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      "run_id: run-a",
      "run_id: run-b",
    ]);

    expect(() => parseHarnessMarkers(comment)).toThrow(HarnessMarkerParseError);
    try {
      parseHarnessMarkers(comment);
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessMarkerParseError);
      expect((error as HarnessMarkerParseError).code).toBe("conflicting_identity_markers");
    }
  });

  it("allows duplicate keys with identical values", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      "run_id: run-a",
      "run_id: run-a",
    ]);

    expect(parseHarnessMarkers(comment).runId).toBe("run-a");
  });

  it("rejects inconsistent raw and hash identity pairs", () => {
    const comment = harnessMetadataBlock([
      "harness-orchestrator-v1",
      "phase: planning",
      `cursor_agent_id: ${cursorAgentId}`,
      `cursor_agent_id_hash: ${hashProviderIdentity("different-id")}`,
    ]);

    expect(() => parseHarnessMarkers(comment)).toThrow(HarnessMarkerParseError);
    try {
      parseHarnessMarkers(comment);
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessMarkerParseError);
      expect((error as HarnessMarkerParseError).code).toBe("conflicting_identity_markers");
    }
  });
});
