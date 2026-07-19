import { describe, expect, it } from "vitest";
import {
  assessClassicPatGuidedCapabilities,
  classicPatHasWorkflowScope,
  parseOAuthScopes,
  resolveGitHubTokenType,
  type GitHubTokenMetadata,
} from "../../src/setup/github-workflow-permissions.js";

function classicMetadata(
  scopes: string[],
  overrides?: Partial<GitHubTokenMetadata>,
): GitHubTokenMetadata {
  return {
    login: "weston-uribe",
    tokenType: "classic",
    oauthScopes: scopes,
    hasWorkflowScope: scopes.includes("workflow"),
    hasRepoScope: scopes.includes("repo") || scopes.includes("public_repo"),
    ...overrides,
  };
}

describe("github-workflow-permissions", () => {
  it("parses OAuth scope headers", () => {
    expect(parseOAuthScopes("repo, workflow, read:user")).toEqual([
      "repo",
      "workflow",
      "read:user",
    ]);
    expect(parseOAuthScopes(null)).toEqual([]);
  });

  it("resolves classic vs fine-grained token types", () => {
    expect(resolveGitHubTokenType("fine-grained", [])).toBe("fine-grained");
    expect(resolveGitHubTokenType("classic", ["repo"])).toBe("classic");
    expect(resolveGitHubTokenType(null, ["repo"])).toBe("classic");
    expect(resolveGitHubTokenType(null, [])).toBe("unknown");
  });

  it("detects missing workflow scope on classic PATs", () => {
    expect(classicPatHasWorkflowScope(["repo"])).toBe(false);
    expect(classicPatHasWorkflowScope(["repo", "workflow"])).toBe(true);
  });

  it("fails classic PAT guided assessment when workflow scope is missing", () => {
    const result = assessClassicPatGuidedCapabilities(classicMetadata(["repo"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("missing workflow access");
      expect(result.message).toContain("How do I get a GitHub token?");
    }
  });

  it("passes classic PAT guided assessment when repo and workflow scopes are present", () => {
    const result = assessClassicPatGuidedCapabilities(
      classicMetadata(["repo", "workflow"]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("defers fine-grained workflow proof to Step 2", () => {
    const result = assessClassicPatGuidedCapabilities(
      classicMetadata([], { tokenType: "fine-grained" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.limitation).toContain("Step 2");
    }
  });
});
