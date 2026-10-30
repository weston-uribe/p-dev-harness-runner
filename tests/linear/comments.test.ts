import { describe, expect, it } from "vitest";
import {
  formatHarnessCommentFooter,
  formatPhaseStartComment,
  formatPlanningComment,
  findPhaseStartMarker,
  hasPlanningCompletionMarker,
  hasPhaseStartMarker,
} from "../../src/linear/comments.js";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";
import {
  getVisibleCommentBody,
  hasVisibleMachineMetadata,
} from "./comment-assertions.js";

describe("linear comments", () => {
  it("formats harness hidden metadata with required marker fields", () => {
    const cursorAgentId = "agent-123";
    const cursorRunId = "run-456";
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "planning",
      runId: "2026-07-06T20-30-00Z-WES-11",
      cursorAgentIdHash: hashProviderIdentity(cursorAgentId),
      cursorRunIdHash: hashProviderIdentity(cursorRunId),
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/owner/example-target-app",
    });

    expect(footer).toContain("<!--");
    expect(footer).toContain("harness-orchestrator-v1");
    expect(footer).toContain("phase: planning");
    expect(footer).toContain("run_id: 2026-07-06T20-30-00Z-WES-11");
    expect(footer).toContain(
      `cursor_agent_id_hash: ${hashProviderIdentity(cursorAgentId)}`,
    );
    expect(footer).toContain(
      `cursor_run_id_hash: ${hashProviderIdentity(cursorRunId)}`,
    );
    expect(footer).not.toContain("cursor_agent_id:");
    expect(footer).not.toContain("cursor_run_id:");
    expect(footer).toContain("model: composer-2.5");
    expect(footer).toContain("prompt_version: planning@1");
    expect(footer).toContain(
      "target_repo: https://github.com/owner/example-target-app",
    );
    expect(footer).toContain("execution_environment:");
    expect(footer).toContain("execution_environment_marker:");
  });

  it("wraps planning body with harness comment format and hidden metadata", () => {
    const body = formatPlanningComment("Step 1: inspect repo", {
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "planning",
      runId: "run-1",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
    });

    expect(body).toContain("# Comment from harness");
    expect(body).toContain("**Phase:** Planning complete");
    expect(body).toContain("## For the PM");
    expect(body).toContain("Planning is complete.");
    expect(body).toContain("Implementation will start automatically.");
    expect(body).toContain("No PM action is needed until the issue reaches **PM Review**.");
    expect(body).not.toContain("move the issue to **Ready for Build**");
    expect(body).toContain("Step 1: inspect repo");
    expect(hasVisibleMachineMetadata(body)).toBe(false);
    expect(body).not.toContain("🤖 Harness update");
  });

  it("formats planning-only terminal comment when planningOnlyTerminal is true", () => {
    const body = formatPlanningComment(
      "Plan only scope",
      {
        orchestratorMarker: "harness-orchestrator-v1",
        phase: "planning",
        runId: "run-plan-only",
        model: "composer-2.5",
        promptVersion: "planning@1",
        targetRepo: "https://github.com/example/repo",
      },
      { planningOnlyTerminal: true },
    );

    expect(body).toContain("planning-only execution");
    expect(body).toContain("implementation was not started");
    expect(body).toContain("**Canceled**");
    expect(body).not.toContain("Implementation will start automatically.");
  });

  it("detects planning completion marker in comment body", () => {
    const comment = formatPlanningComment("Plan content", {
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "planning",
      runId: "run-abc",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/example/repo",
    });

    expect(
      hasPlanningCompletionMarker(comment, "harness-orchestrator-v1"),
    ).toBe(true);
    expect(hasPlanningCompletionMarker("no markers here", "harness-orchestrator-v1")).toBe(
      false,
    );
  });

  it("formats building start comment with GitHub Actions link only and no visible metadata", () => {
    const cursorAgentId = "bc-agent";
    const cursorRunId = "run-abc";
    const body = formatPhaseStartComment(
      "implementation_start",
      {
        issueKey: "WES-18",
        targetRepo: "https://github.com/owner/example-target-app",
        branch: "cursor/wes-18-test",
        githubActionsRunUrl:
          "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/123",
      },
      {
        orchestratorMarker: "harness-orchestrator-v1",
        runId: "2026-07-07T21-00-00Z-WES-18",
        model: "composer-2.5",
        promptVersion: "implementation@1",
        targetRepo: "https://github.com/owner/example-target-app",
        branch: "cursor/wes-18-test",
        githubActionsRunUrl:
          "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/123",
        cursorAgentIdHash: hashProviderIdentity(cursorAgentId),
        cursorRunIdHash: hashProviderIdentity(cursorRunId),
      },
    );

    const visible = getVisibleCommentBody(body);

    expect(body).toContain("# Comment from harness");
    expect(body).toContain("**Phase:** Building");
    expect(visible).toContain("[GitHub Actions run]");
    expect(visible).not.toContain("[Cursor Cloud run]");
    expect(visible).not.toContain("## For the PM");
    expect(visible).not.toContain("## For the engineer");
    expect(visible).not.toContain("Issue: WES-18");
    expect(visible).not.toContain("cursor_agent_id");
    expect(visible).not.toContain("cursor_agent_id_hash");
    expect(hasVisibleMachineMetadata(body)).toBe(false);
  });

  it("formats merging start comment with GitHub Actions link only", () => {
    const body = formatPhaseStartComment(
      "merge_start",
      {
        issueKey: "WES-18",
        targetRepo: "https://github.com/owner/example-target-app",
        prUrl: "https://github.com/owner/example-target-app/pull/7",
        githubActionsRunUrl:
          "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/456",
      },
      {
        orchestratorMarker: "harness-orchestrator-v1",
        runId: "run-merge-1",
        model: "composer-2.5",
        promptVersion: "merge@1",
        targetRepo: "https://github.com/owner/example-target-app",
        prUrl: "https://github.com/owner/example-target-app/pull/7",
        githubActionsRunUrl:
          "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/456",
      },
    );

    const visible = getVisibleCommentBody(body);

    expect(body).toContain("**Phase:** Merging");
    expect(visible).toContain("[GitHub Actions run]");
    expect(visible).not.toContain("[Cursor Cloud run]");
    expect(visible).not.toContain("[Pull request]");
    expect(visible).not.toContain("## For the PM");
    expect(visible).not.toContain("## For the engineer");
    expect(hasVisibleMachineMetadata(body)).toBe(false);
  });

  it("detects duplicate phase-start markers by run id", () => {
    const comment = formatPhaseStartComment(
      "merge_start",
      {
        issueKey: "WES-18",
        targetRepo: "https://github.com/owner/example-target-app",
        prUrl: "https://github.com/owner/example-target-app/pull/7",
      },
      {
        orchestratorMarker: "harness-orchestrator-v1",
        runId: "run-merge-1",
        model: "composer-2.5",
        promptVersion: "merge@1",
        targetRepo: "https://github.com/owner/example-target-app",
        prUrl: "https://github.com/owner/example-target-app/pull/7",
      },
    );

    expect(
      hasPhaseStartMarker(comment, "harness-orchestrator-v1", "merge_start", "run-merge-1"),
    ).toBe(true);
    expect(
      findPhaseStartMarker(
        [{ body: comment }],
        "harness-orchestrator-v1",
        "merge_start",
        "run-merge-1",
      ),
    ).toBe(true);
    expect(
      hasPhaseStartMarker(comment, "harness-orchestrator-v1", "merge_start", "other-run"),
    ).toBe(false);
  });
});
