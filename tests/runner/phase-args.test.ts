import { describe, expect, it } from "vitest";
import {
  DISPATCH_PHASE_ARGS,
  RUN_PHASE_ARGS,
  isDispatchPhase,
  isRunPhaseArg,
} from "../../src/runner/phase-args.js";

describe("phase-args", () => {
  it("accepts all dispatch phases", () => {
    for (const phase of DISPATCH_PHASE_ARGS) {
      expect(isDispatchPhase(phase)).toBe(true);
      expect(isRunPhaseArg(phase)).toBe(true);
    }
  });

  it("accepts dry-run for run phase only", () => {
    expect(isRunPhaseArg("dry-run")).toBe(true);
    expect(isDispatchPhase("dry-run")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    expect(isDispatchPhase("  PLANNING ")).toBe(true);
    expect(isRunPhaseArg(" Dry-Run ")).toBe(true);
  });

  it("rejects unknown phases", () => {
    expect(isDispatchPhase("destroy")).toBe(false);
    expect(isRunPhaseArg("destroy")).toBe(false);
    expect(isDispatchPhase(null)).toBe(false);
    expect(isRunPhaseArg(undefined)).toBe(false);
  });

  it("includes expected run phase values", () => {
    expect(RUN_PHASE_ARGS).toContain("merge");
    expect(DISPATCH_PHASE_ARGS).not.toContain("dry-run");
  });
});
