import { describe, expect, it, vi } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  assertImplementationEligibleStatus,
  checkImplementationIdempotency,
  isNarrowImplementationIssue,
} from "../../src/runner/idempotency.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: {
      implementation: ["Ready for Build"],
    },
    transitionalStatuses: {
      buildingInProgress: "Building",
      prOpen: "PR Open",
    },
  },
  repos: [],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-12",
  title: "Test",
  description: "",
  status: "Ready for Build",
  projectName: null,
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

describe("implementation idempotency", () => {
  it("skips when issue is already PR Open", async () => {
    const result = await checkImplementationIdempotency(
      config,
      { ...issue, status: "PR Open" },
      [],
      false,
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("duplicate_phase_completed");
  });

  it("bypasses duplicate checks with force", async () => {
    const result = await checkImplementationIdempotency(
      config,
      { ...issue, status: "PR Open" },
      [],
      true,
    );

    expect(result.skip).toBe(false);
  });

  it("rejects wrong implementation status", () => {
    expect(() =>
      assertImplementationEligibleStatus(
        config,
        { ...issue, status: "Backlog" },
        false,
      ),
    ).toThrow(/wrong_status/);
  });

  it("allows Building status for recovery retries", () => {
    expect(() =>
      assertImplementationEligibleStatus(
        config,
        { ...issue, status: "Building" },
        false,
      ),
    ).not.toThrow();
  });

  it("requests handoff recovery when an implementation PR already exists", async () => {
    const github = {
      listPullRequests: async () => [
        {
          number: 12,
          html_url: "https://github.com/o/r/pull/12",
          head: { ref: "cursor/wes-12-test", sha: "abc" },
          base: { ref: "dev" },
        },
      ],
    };

    const result = await checkImplementationIdempotency(
      config,
      issue,
      [],
      false,
      {
        github: github as never,
        targetRepo: "https://github.com/o/r",
        baseBranch: "dev",
      },
    );

    expect(result.skip).toBe(true);
    expect(result.recoveryHandoff).toBe(true);
    expect(result.discoveredPrUrl).toBe("https://github.com/o/r/pull/12");
  });

  it("suppresses duplicate implementation while Building is fresh", async () => {
    vi.setSystemTime(new Date("2026-07-08T02:50:00.000Z"));

    const result = await checkImplementationIdempotency(
      config,
      { ...issue, status: "Building" },
      [
        {
          id: "comment-1",
          body: `<!--\nharness-orchestrator-v1\nphase: implementation_start\nrun_id: 2026-07-08T02-49-25-188Z-WES-12\n-->`,
        },
      ],
      false,
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("implementation_in_progress");

    vi.useRealTimers();
  });

  it("identifies narrow implementation issues", () => {
    expect(
      isNarrowImplementationIssue({
        task: "Add a temporary hello world page.",
        acceptanceCriteria: ["Page exists", "PR opens"],
        outOfScope: [],
        parseErrors: [],
      }),
    ).toBe(true);
  });
});
