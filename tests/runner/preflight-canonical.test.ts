import { describe, expect, it, vi } from "vitest";

vi.unmock("../../src/workflow/preflight-canonical.js");

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(() => ({})),
  listTeamWorkflowStates: vi.fn(async () => [
    { id: "s-backlog", name: "Backlog", type: "backlog" },
    { id: "s-rfp", name: "Ready for Planning", type: "unstarted" },
    { id: "s-planning", name: "Planning", type: "started" },
    { id: "s-rfb", name: "Ready for Build", type: "unstarted" },
    { id: "s-building", name: "Building", type: "started" },
    { id: "s-pr", name: "PR Open", type: "started" },
    { id: "s-pm", name: "PM Review", type: "started" },
    { id: "s-eng", name: "Engineering Review", type: "started" },
    { id: "s-rev", name: "Needs Revision", type: "unstarted" },
    { id: "s-revising", name: "Revising", type: "started" },
    { id: "s-rtm", name: "Ready to Merge", type: "started" },
    { id: "s-merging", name: "Merging", type: "started" },
    { id: "s-mtd", name: "Merged to Dev", type: "completed" },
    { id: "s-deployed", name: "Merged / Deployed", type: "completed" },
    { id: "s-blocked", name: "Blocked", type: "started" },
    { id: "s-canceled", name: "Canceled", type: "canceled" },
  ]),
}));

import {
  canonicalPreflightErrorMessage,
  runCanonicalWorkflowPreflight,
} from "../../src/workflow/preflight-canonical.js";

describe("canonical workflow preflight", () => {
  it("passes when Linear workflow states match the canonical contract", async () => {
    const result = await runCanonicalWorkflowPreflight({
      linearApiKey: "test-key",
      teamId: "team-1",
      config: {
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: "runs",
        repos: [],
        allowedTargetRepos: [],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.informationalWarnings).toEqual([]);
    expect(result.resolvedStatuses["ready-for-build"]?.id).toBe("s-rfb");
  });

  it("formats canonical validation failures for runner errors", async () => {
    const { listTeamWorkflowStates } = await import("../../src/setup/linear-setup-client.js");
    vi.mocked(listTeamWorkflowStates).mockResolvedValueOnce([
      { id: "s-backlog", name: "Backlog", type: "backlog" },
    ]);

    const result = await runCanonicalWorkflowPreflight({
      linearApiKey: "test-key",
      teamId: "team-1",
      config: {
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: "runs",
        repos: [],
        allowedTargetRepos: [],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(canonicalPreflightErrorMessage(result)).toMatch(/^canonical_workflow_invalid:/);
  });
});
