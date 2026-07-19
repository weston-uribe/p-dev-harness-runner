import { describe, expect, it } from "vitest";
import {
  normalizeRepoUrl,
  repoUrlsEquivalent,
  isValidGithubRepoUrl,
} from "../../src/resolver/normalize-repo.js";

describe("normalizeRepoUrl", () => {
  const canonical = "https://github.com/owner/example-target-app";

  it.each([
    ["https://github.com/owner/example-target-app", canonical],
    ["https://github.com/owner/example-target-app/", canonical],
    ["github.com/owner/example-target-app", canonical],
    ["github.com/owner/example-target-app/", canonical],
    ["owner/example-target-app", canonical],
    ["owner/example-target-app/", canonical],
    ["http://github.com/owner/example-target-app", canonical],
  ])("normalizes %s to canonical https URL", (input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });

  it("treats equivalent forms as the same repo", () => {
    expect(
      repoUrlsEquivalent(
        "github.com/owner/example-target-app",
        "https://github.com/owner/example-target-app",
      ),
    ).toBe(true);
    expect(
      repoUrlsEquivalent(
        "owner/example-target-app",
        "https://github.com/owner/example-target-app/",
      ),
    ).toBe(true);
  });

  it("validates canonical github URLs", () => {
    expect(isValidGithubRepoUrl(canonical)).toBe(true);
    expect(isValidGithubRepoUrl("github.com/owner/example-target-app")).toBe(
      false,
    );
  });
});
