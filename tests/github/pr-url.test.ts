import { describe, expect, it } from "vitest";
import { parsePrUrl } from "../../src/github/pr-url.js";

describe("parsePrUrl", () => {
  it("parses a valid GitHub PR URL", () => {
    const parsed = parsePrUrl(
      "https://github.com/owner/example-target-app/pull/4",
    );

    expect(parsed).toEqual({
      owner: "owner",
      repo: "example-target-app",
      pullNumber: 4,
      repoUrl: "https://github.com/owner/example-target-app",
    });
  });

  it("accepts trailing slash", () => {
    const parsed = parsePrUrl(
      "https://github.com/owner/example-target-app/pull/4/",
    );
    expect(parsed?.pullNumber).toBe(4);
  });

  it("returns null for invalid URLs", () => {
    expect(parsePrUrl("https://github.com/o/r/issues/1")).toBeNull();
    expect(parsePrUrl("not-a-url")).toBeNull();
    expect(parsePrUrl("")).toBeNull();
  });
});
