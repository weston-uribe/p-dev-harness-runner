import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import { GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX } from "../../src/setup/github-workflow-permissions.js";
import {
  formatGitHubApiErrorMessage,
  sanitizeGitHubSetupError,
  sanitizeGitHubWorkflowSetupError,
} from "../../src/setup/github-remote-setup-live.js";

describe("github-remote-setup-live", () => {
  it("sanitizes GitHub API error bodies before surfacing messages", () => {
    const error = new GitHubApiError(
      401,
      "GitHub API 401: token ghp_sentinelGitHubTokenValue leaked in body",
    );

    const message = sanitizeGitHubSetupError(error);
    expect(message).not.toContain("ghp_sentinelGitHubTokenValue");
    expect(message).toContain("401");
  });

  it("formats JSON GitHub API errors as readable messages", () => {
    const message = formatGitHubApiErrorMessage(
      404,
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
    );

    expect(message).toBe("GitHub API 404: Not Found");
    expect(message).not.toContain("documentation_url");
  });

  it("maps workflow scope 403 errors to setup guidance", () => {
    const message = sanitizeGitHubWorkflowSetupError(
      new GitHubApiError(
        403,
        '{"message":"refusing to allow an OAuth App to create or update workflow `.github/workflows/trigger-harness-production-sync.yml` without `workflow` scope","documentation_url":"https://docs.github.com/rest","status":"403"}',
      ),
    );

    expect(message).toContain("workflow scope");
    expect(message).toContain("GITHUB_TOKEN");
    expect(message).toContain(GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX);
    expect(message).not.toContain("OAuth App");
  });

  it("maps misleading workflow 404 errors to setup guidance", () => {
    const message = sanitizeGitHubWorkflowSetupError(
      new GitHubApiError(
        404,
        '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/contents#create-or-update-file-contents","status":"404"}',
      ),
    );

    expect(message).toContain("workflow scope");
    expect(message).toContain("HTTP 404");
    expect(message).toContain(GITHUB_STEP5_WORKFLOW_PERMISSION_FALLBACK_PREFIX);
    expect(message).not.toContain('{"message"');
  });
});
