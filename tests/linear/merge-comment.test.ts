import { describe, expect, it } from "vitest";
import {
  buildMergeCompletionCommentBody,
  findMergeMarkerForPrUrl,
  formatMergeComment,
  hasMergeCompletionMarker,
} from "../../src/linear/comments.js";
import { resolvePreviewLinks } from "../../src/preview/urls.js";

const marker = "harness-orchestrator-v1";
const prUrl = "https://github.com/owner/example-target-app/pull/4";

describe("merge completion comment", () => {
  it("detects merge completion marker", () => {
    const body = formatMergeComment("## PM merge complete", {
      orchestratorMarker: marker,
      phase: "merge",
      runId: "merge-run",
      model: "composer-2.5",
      promptVersion: "merge@1",
      targetRepo: "https://github.com/owner/example-target-app",
      prUrl,
      mergeCommitSha: "abc123",
    });
    expect(hasMergeCompletionMarker(body, marker)).toBe(true);
    expect(findMergeMarkerForPrUrl([{ body }], marker, prUrl)).toBe(true);
  });

  it("builds merge completion body with deployment warning", () => {
    const previewLinks = resolvePreviewLinks({
      prPreviewUrl: null,
      integrationPreviewUrl: "https://dev.example.vercel.app",
      productionUrl: null,
      capturedDeploymentUrl: null,
      mergedBaseBranch: "main",
      productionBranch: "main",
    });
    const body = buildMergeCompletionCommentBody({
      prUrl,
      branch: "cursor/test",
      targetRepo: "https://github.com/owner/example-target-app",
      mergeMethod: "squash",
      mergeCommitSha: "abc123",
      mergedAt: "2026-07-07T06:00:00.000Z",
      baseBranch: "main",
      productionBranch: "main",
      previewLinks,
      deploymentWarning: "Production deployment URL not captured",
      changedFiles: ["app/page.tsx"],
      checkSummary: "- Passed: 1",
      finalIssueStatus: "Merged / Deployed",
      harnessRunId: "merge-run",
      previousHandoffRunId: "handoff-run",
      previousRevisionRunId: "revision-run",
    });
    expect(body).toContain("# Comment from harness");
    expect(body).toContain("Production deployment URL not captured");
    expect(body).toContain("revision-run");
    expect(body).not.toContain("🤖 Harness update");
  });
});
