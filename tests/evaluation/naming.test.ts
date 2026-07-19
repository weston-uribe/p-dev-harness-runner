import { describe, expect, it } from "vitest";
import {
  agentObservationDisplayName,
  aggregateGenerationDisplayName,
  extractIssueKeyFromDisplayName,
  isPlannerAgentDisplayName,
  isPlanningTraceDisplayName,
  phaseTraceDisplayName,
  sessionDisplayName,
} from "../../src/evaluation/naming.js";

describe("evaluation naming", () => {
  it("builds human-readable session and phase names for FRE-3", () => {
    expect(sessionDisplayName("FRE-3")).toBe("FRE-3");
    expect(
      phaseTraceDisplayName({ issueKey: "FRE-3", phase: "planning" }),
    ).toBe("FRE-3 · planning");
    expect(
      phaseTraceDisplayName({
        issueKey: "FRE-3",
        phase: "revision",
        revisionCycleIndex: 1,
      }),
    ).toBe("FRE-3 · revision · cycle 1");
    expect(
      agentObservationDisplayName({ issueKey: "FRE-3", role: "planner" }),
    ).toBe("FRE-3 · planner");
    expect(
      aggregateGenerationDisplayName({
        issueKey: "FRE-3",
        role: "implementer",
      }),
    ).toBe("FRE-3 · implementer · Cursor run");
  });

  it("extracts issue keys and detects planning/planner display names", () => {
    expect(extractIssueKeyFromDisplayName("FRE-3 · planning")).toBe("FRE-3");
    expect(extractIssueKeyFromDisplayName("FRE-3")).toBe("FRE-3");
    expect(isPlanningTraceDisplayName("FRE-3 · planning", "FRE-3")).toBe(true);
    expect(isPlannerAgentDisplayName("FRE-3 · planner", "FRE-3")).toBe(true);
    expect(isPlanningTraceDisplayName("p-dev.planning", "FRE-3")).toBe(false);
  });
});
