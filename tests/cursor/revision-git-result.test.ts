import { describe, expect, it } from "vitest";
import { extractRevisionGitResult } from "../../src/cursor/revision-git-result.js";
import { RevisionError } from "../../src/runner/errors.js";

describe("extractRevisionGitResult", () => {
  const targetRepo = "https://github.com/owner/example-target-app";
  const expectedBranch = "cursor/wes-13-test";
  const expectedPrUrl =
    "https://github.com/owner/example-target-app/pull/4";

  it("accepts git metadata matching existing PR and branch", () => {
    const result = extractRevisionGitResult(
      {
        branches: [
          {
            repoUrl: targetRepo,
            branch: expectedBranch,
            prUrl: expectedPrUrl,
          },
        ],
      },
      targetRepo,
      expectedBranch,
      expectedPrUrl,
    );

    expect(result.prUrl).toBe(expectedPrUrl);
    expect(result.branch).toBe(expectedBranch);
  });

  it("rejects a new PR number", () => {
    expect(() =>
      extractRevisionGitResult(
        {
          branches: [
            {
              repoUrl: targetRepo,
              branch: expectedBranch,
              prUrl: "https://github.com/owner/example-target-app/pull/99",
            },
          ],
        },
        targetRepo,
        expectedBranch,
        expectedPrUrl,
      ),
    ).toThrow(RevisionError);
  });

  it("rejects a different branch", () => {
    expect(() =>
      extractRevisionGitResult(
        {
          branches: [
            {
              repoUrl: targetRepo,
              branch: "cursor/other-branch",
              prUrl: expectedPrUrl,
            },
          ],
        },
        targetRepo,
        expectedBranch,
        expectedPrUrl,
      ),
    ).toThrow(RevisionError);
  });
});
