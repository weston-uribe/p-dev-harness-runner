import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatGitHubActionsRunLink,
  getGitHubActionsRunUrl,
} from "../../src/github/actions-url.js";

describe("getGitHubActionsRunUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds run URL from GitHub Actions env vars", () => {
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "weston-uribe/agentic-product-development-harness";
    process.env.GITHUB_RUN_ID = "28899991092";

    expect(getGitHubActionsRunUrl()).toBe(
      "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/28899991092",
    );
  });

  it("returns null when env vars are missing", () => {
    delete process.env.GITHUB_SERVER_URL;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_RUN_ID;

    expect(getGitHubActionsRunUrl()).toBeNull();
  });

  it("formats markdown link for Actions run URL", () => {
    expect(
      formatGitHubActionsRunLink(
        "https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/123",
      ),
    ).toBe(
      "[GitHub Actions run](https://github.com/weston-uribe/agentic-product-development-harness/actions/runs/123)",
    );
  });
});
