import { describe, expect, it } from "vitest";
import {
  normalizeGitHubRepositoryName,
  validateGitHubRepositoryName,
  validateRepositoryOwnerMatchesActor,
} from "../../src/setup/github-repository-name.js";

describe("github-repository-name", () => {
  it("defaults visibility validation separately and normalizes trimmed names", () => {
    expect(normalizeGitHubRepositoryName("  my-product  ")).toBe("my-product");
  });

  it("rejects empty and invalid repository names", () => {
    expect(validateGitHubRepositoryName("").ok).toBe(false);
    expect(validateGitHubRepositoryName("bad name").ok).toBe(false);
    expect(validateGitHubRepositoryName(".hidden").ok).toBe(false);
    expect(validateGitHubRepositoryName("settings").ok).toBe(false);
  });

  it("rejects owner changes that do not match the authenticated actor", () => {
    expect(
      validateRepositoryOwnerMatchesActor("other-user", "test-user").ok,
    ).toBe(false);
    expect(validateRepositoryOwnerMatchesActor("test-user", "test-user").ok).toBe(
      true,
    );
  });
});
