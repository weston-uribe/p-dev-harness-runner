import { describe, expect, it } from "vitest";
import { resolveDispatchGithubToken } from "../../src/public-execution/runtime-repos.js";

describe("resolveDispatchGithubToken", () => {
  it("prefers GITHUB_DISPATCH_TOKEN when present", () => {
    expect(
      resolveDispatchGithubToken({
        GITHUB_DISPATCH_TOKEN: "dispatch-present",
        HARNESS_GITHUB_TOKEN: "harness-present",
        GITHUB_TOKEN: "github-present",
      }),
    ).toBe("dispatch-present");
  });

  it("falls back to HARNESS_GITHUB_TOKEN when dispatch token is absent", () => {
    expect(
      resolveDispatchGithubToken({
        HARNESS_GITHUB_TOKEN: "harness-present",
        GITHUB_TOKEN: "github-present",
      }),
    ).toBe("harness-present");
  });

  it("never falls back to GITHUB_TOKEN", () => {
    expect(
      resolveDispatchGithubToken({
        GITHUB_TOKEN: "github-present",
      }),
    ).toBeNull();
  });

  it("returns null when both dispatch and harness tokens are absent", () => {
    expect(resolveDispatchGithubToken({})).toBeNull();
  });

  it("trims whitespace and treats blank as absent", () => {
    expect(
      resolveDispatchGithubToken({
        GITHUB_DISPATCH_TOKEN: "   ",
        HARNESS_GITHUB_TOKEN: " harness-present ",
      }),
    ).toBe("harness-present");
  });
});
