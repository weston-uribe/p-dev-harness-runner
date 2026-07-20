import { describe, expect, it } from "vitest";
import { formatValidationReport } from "../../src/validate/report.js";
import type { IssueValidationResult } from "../../src/validate/types.js";

function baseResult(
  overrides: Partial<IssueValidationResult> = {},
): IssueValidationResult {
  return {
    validForPlanning: true,
    validForDirectImplementation: false,
    intendedPhase: "implementation",
    passesIntendedPhase: false,
    targetRepo: "https://github.com/owner/example-target-app",
    resolutionSource: "explicit",
    parseErrors: [],
    resolverError: null,
    narrowIssue: false,
    narrowFailureReason: "task length 300 exceeds 240 characters",
    hasPlanningMarker: false,
    planningMarkerMode: "file",
    productInitializationState: null,
    blocksDirectImplementationForUninitializedProduct: false,
    routingNotes: [
      "Advisory: issue exceeds narrow-size heuristics — consider Ready for Planning first, but Ready for Build will still execute if selected.",
    ],
    repairInstructions: [],
    ...overrides,
  };
}

describe("formatValidationReport", () => {
  it("includes intended phase and planning marker fields", () => {
    const report = formatValidationReport(baseResult());

    expect(report).toContain("# Issue Validation Report");
    expect(report).toContain("- Intended phase: implementation");
    expect(report).toContain("- Passes intended phase: no");
    expect(report).toContain("- Planning marker present: n/a");
    expect(report).toContain("## Parser errors");
    expect(report).toContain("## Routing / status notes");
    expect(report).toContain("## Repair instructions");
    expect(report).toContain("advisory heuristic only");
    expect(report).toContain("narrow-size heuristics");
  });

  it("shows planning marker yes in issue mode", () => {
    const report = formatValidationReport(
      baseResult({
        hasPlanningMarker: true,
        planningMarkerMode: "issue",
        validForDirectImplementation: true,
        passesIntendedPhase: true,
      }),
    );

    expect(report).toContain("- Planning marker present: yes");
    expect(report).toContain("- Passes intended phase: yes");
  });
});
