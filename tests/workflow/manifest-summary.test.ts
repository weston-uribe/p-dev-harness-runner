import { describe, expect, it } from "vitest";
import {
  formatManifestSummaryLines,
  readManifestSubsetFromString,
} from "../../src/workflow/manifest-summary.js";

describe("readManifestSubsetFromString", () => {
  it("extracts manifest subset fields", () => {
    const subset = readManifestSubsetFromString(
      JSON.stringify({
        issueKey: "WES-10",
        phase: "planning",
        finalOutcome: "success",
        errorClassification: null,
      }),
    );

    expect(subset).toEqual({
      issueKey: "WES-10",
      phase: "planning",
      finalOutcome: "success",
      errorClassification: null,
    });
  });

  it("returns null for invalid JSON", () => {
    expect(readManifestSubsetFromString("not-json")).toBeNull();
  });
});

describe("formatManifestSummaryLines", () => {
  it("formats summary lines including error classification", () => {
    const lines = formatManifestSummaryLines({
      issueKey: "WES-10",
      phase: "merge",
      finalOutcome: "failed",
      errorClassification: "checks_failing",
    });

    expect(lines).toEqual([
      "- Issue key: `WES-10`",
      "- Phase: `merge`",
      "- Outcome: `failed`",
      "- Error classification: `checks_failing`",
    ]);
  });

  it("uses none when error classification is absent", () => {
    const lines = formatManifestSummaryLines({
      finalOutcome: "success",
    });

    expect(lines).toEqual([
      "- Outcome: `success`",
      "- Error classification: `none`",
    ]);
  });
});
