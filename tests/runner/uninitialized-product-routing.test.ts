import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  rerouteUninitializedProductToPlanning,
  shouldRerouteUninitializedProductToPlanning,
} from "../../src/runner/uninitialized-product-routing.js";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: vi.fn(),
  listIssueComments: vi.fn(),
  postIssueComment: vi.fn(),
  transitionIssueStatus: vi.fn(),
}));

import {
  listIssueComments,
  postIssueComment,
  transitionIssueStatus,
} from "../../src/linear/writer.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      implementation: ["Ready for Build"],
    },
    transitionalStatuses: {
      readyForBuild: "Ready for Build",
    },
  },
  repos: [],
  allowedTargetRepos: [],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-1",
  title: "Test",
  description: "",
  status: "Ready for Build",
  projectId: "project-1",
  projectName: "Example",
  teamName: "WES",
  teamKey: null,
  teamId: "team-1",
  url: null,
};

describe("uninitialized-product-routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects reroute when product is uninitialized and status is Ready for Build", () => {
    expect(
      shouldRerouteUninitializedProductToPlanning(
        "Ready for Build",
        config,
        { state: "uninitialized", hasApprovedArchitecture: false },
      ),
    ).toBe(true);
  });

  it("posts reroute comment and transitions status once", async () => {
    vi.mocked(listIssueComments).mockResolvedValue([]);
    vi.mocked(postIssueComment).mockResolvedValue("comment-1");
    vi.mocked(transitionIssueStatus).mockResolvedValue(undefined);

    const result = await rerouteUninitializedProductToPlanning({
      config,
      issue,
      targetRepo: "https://github.com/owner/example-target-app",
      productInitialization: { state: "uninitialized", hasApprovedArchitecture: false },
      linearApiKey: "test-key",
      linearClient: {} as never,
    });

    expect(result.rerouted).toBe(true);
    expect(result.planningStatus).toBe("Ready for Planning");
    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssueStatus).toHaveBeenCalledWith(
      {},
      issue,
      "Ready for Planning",
    );
  });

  it("skips duplicate reroute comments", async () => {
    vi.mocked(listIssueComments).mockResolvedValue([
      {
        id: "comment-1",
        body: [
          "Harness rerouted this issue",
          "<!--",
          "harness-orchestrator-v1",
          "phase: uninitialized_product_reroute",
          "run_id: product-initialization-policy",
          "-->",
        ].join("\n"),
      },
    ]);

    const result = await rerouteUninitializedProductToPlanning({
      config,
      issue,
      targetRepo: "https://github.com/owner/example-target-app",
      productInitialization: { state: "uninitialized", hasApprovedArchitecture: false },
      linearApiKey: "test-key",
      linearClient: {} as never,
    });

    expect(result.rerouted).toBe(false);
    expect(result.skippedReason).toBe("duplicate_reroute_comment");
    expect(postIssueComment).not.toHaveBeenCalled();
  });
});
