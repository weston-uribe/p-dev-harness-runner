import { describe, expect, it } from "vitest";
import {
  extractIssueKey,
  extractIssueKeyFromUrl,
  validateIssueKeyTeam,
} from "../../src/webhook/extract-issue-key.js";

describe("extractIssueKeyFromUrl", () => {
  it("extracts issue key from Linear URL", () => {
    expect(
      extractIssueKeyFromUrl("https://linear.app/weston/issue/WES-13/target-app-link"),
    ).toBe("WES-13");
  });

  it("extracts issue key before hash fragment", () => {
    expect(
      extractIssueKeyFromUrl("https://linear.app/weston/issue/WES-13/foo#comment-1"),
    ).toBe("WES-13");
  });

  it("returns null for invalid URLs", () => {
    expect(extractIssueKeyFromUrl("https://example.com/issues/abc")).toBeNull();
  });
});

describe("extractIssueKey", () => {
  it("prefers data.identifier", () => {
    expect(
      extractIssueKey({
        identifier: "WES-20",
        payloadUrl: "https://linear.app/weston/issue/WES-99/other",
        teamKey: "WES",
      }),
    ).toBe("WES-20");
  });

  it("falls back to URL when identifier is missing", () => {
    expect(
      extractIssueKey({
        identifier: null,
        payloadUrl: "https://linear.app/weston/issue/WES-21/other",
        teamKey: "WES",
      }),
    ).toBe("WES-21");
  });

  it("rejects keys outside configured team prefix", () => {
    expect(
      extractIssueKey({
        identifier: "LIN-1",
        teamKey: "WES",
      }),
    ).toBeNull();
  });
});

describe("validateIssueKeyTeam", () => {
  it("accepts matching team keys", () => {
    expect(validateIssueKeyTeam("WES-13", "WES")).toBe(true);
  });

  it("accepts any key when team key is not configured", () => {
    expect(validateIssueKeyTeam("LIN-1", null)).toBe(true);
  });
});
