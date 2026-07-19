import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  assertHandoffEligibleStatus,
  checkHandoffIdempotency,
} from "../../src/runner/idempotency.js";
import { inferPhaseFromStatus } from "../../src/runner/phase-infer.js";
import {
  buildHandoffCommentBody,
  formatHarnessCommentFooter,
  hasHandoffCompletionMarker,
} from "../../src/linear/comments.js";
import { repoUrlsEquivalent } from "../../src/resolver/normalize-repo.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: {
      handoff: ["PR Open"],
    },
    transitionalStatuses: {
      prOpen: "PR Open",
      pmReview: "PM Review",
      blocked: "Blocked",
    },
  },
  repos: [],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-13",
  title: "Test",
  description: "",
  status: "PR Open",
  projectName: null,
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

describe("handoff idempotency", () => {
  it("does not skip on historical handoff marker without matching subject", () => {
    const result = checkHandoffIdempotency(
      config,
      issue,
      [
        {
          id: "c1",
          body: `---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-1\npr_url: https://github.com/o/r/pull/1\n---`,
        },
      ],
      false,
      { currentSubjectIdentity: "subject-new" },
    );

    expect(result.skip).toBe(false);
  });

  it("skips when handoff subject identity already completed", () => {
    const result = checkHandoffIdempotency(
      config,
      issue,
      [
        {
          id: "c1",
          body: `<!--\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-1\npr_url: https://github.com/o/r/pull/1\nhandoff_subject_identity: subject-abc\n-->`,
        },
      ],
      false,
      { currentSubjectIdentity: "subject-abc" },
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("duplicate_phase_completed");
  });

  it("bypasses duplicate checks with force", () => {
    const result = checkHandoffIdempotency(
      config,
      issue,
      [
        {
          id: "c1",
          body: `---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-1\npr_url: https://github.com/o/r/pull/1\n---`,
        },
      ],
      true,
    );

    expect(result.skip).toBe(false);
  });

  it("allows Building status for recovery handoff", () => {
    expect(() =>
      assertHandoffEligibleStatus(
        config,
        { ...issue, status: "Building" },
        false,
      ),
    ).not.toThrow();
  });

  it("rejects wrong handoff status", () => {
    expect(() =>
      assertHandoffEligibleStatus(
        config,
        { ...issue, status: "Ready for Build" },
        false,
      ),
    ).toThrow(/wrong_status/);
  });
});

describe("inferPhaseFromStatus", () => {
  it("routes PR Open to handoff", () => {
    expect(inferPhaseFromStatus("PR Open", config).phase).toBe("handoff");
  });

  it("routes Ready for Build to implementation", () => {
    expect(inferPhaseFromStatus("Ready for Build", config).phase).toBe(
      "implementation",
    );
  });
});

describe("handoff comment formatting", () => {
  it("includes required footer fields", () => {
    const footer = formatHarnessCommentFooter({
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "handoff",
      runId: "2026-07-07T05-00-00Z-WES-13",
      model: "composer-2.5",
      promptVersion: "handoff@1",
      targetRepo: "https://github.com/owner/example-target-app",
      branch: "cursor/wes-13-test",
      prUrl: "https://github.com/owner/example-target-app/pull/4",
      previewUrl: "https://example.vercel.app",
      previousImplementationRunId: "2026-07-07T04-50-00Z-WES-13",
    });

    expect(footer).toContain("phase: handoff");
    expect(footer).toContain("pr_url:");
    expect(footer).toContain("branch:");
    expect(footer).toContain("preview_url:");
    expect(footer).toContain("previous_implementation_run_id:");
    expect(
      hasHandoffCompletionMarker(footer, "harness-orchestrator-v1"),
    ).toBe(true);
  });

  it("builds PM handoff body with changed files and checks", () => {
    const body = buildHandoffCommentBody({
      prTitle: "M3 hello world",
      prUrl: "https://github.com/o/r/pull/4",
      branch: "cursor/wes-13-test",
      targetRepo: "https://github.com/o/r",
      previewUrl: "https://example.vercel.app",
      previewWarning: null,
      changedFiles: ["src/app/page.tsx"],
      checkSummary: "- Passed: 2",
      harnessRunId: "run-handoff",
      previousImplementationRunId: "run-impl",
    });

    expect(body).toContain("# Comment from harness");
    expect(body).toContain("**Phase:** PM handoff");
    expect(body).toContain("src/app/page.tsx");
    expect(body).toContain("https://example.vercel.app");
    expect(body).not.toContain("Next actions");
    expect(body).not.toContain("🤖 Harness update");
  });
});

describe("repoUrlsEquivalent", () => {
  it("matches marker target repo with PR repo URL forms", () => {
    expect(
      repoUrlsEquivalent(
        "https://github.com/owner/example-target-app",
        "github.com/owner/example-target-app",
      ),
    ).toBe(true);
  });
});
