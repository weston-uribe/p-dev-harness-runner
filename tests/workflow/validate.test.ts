import { describe, expect, it } from "vitest";
import {
  validateForce,
  validateIssueKey,
  validatePhase,
  validateRepoId,
  validateRepoIdFormat,
} from "../../src/workflow/validate.js";
import { DISPATCH_PHASE_ARGS } from "../../src/runner/phase-args.js";

describe("validateIssueKey", () => {
  it("accepts valid keys", () => {
    expect(validateIssueKey("WES-13")).toBe(true);
    expect(validateIssueKey("wes-1")).toBe(true);
  });

  it("rejects invalid keys", () => {
    expect(validateIssueKey("")).toBe(false);
    expect(validateIssueKey("WES-")).toBe(false);
    expect(validateIssueKey("WES-13; rm -rf")).toBe(false);
    expect(validateIssueKey(null)).toBe(false);
  });
});

describe("validatePhase", () => {
  it("accepts allowed phases", () => {
    for (const phase of DISPATCH_PHASE_ARGS) {
      expect(validatePhase(phase)).toBe(true);
    }
  });

  it("rejects unknown phases", () => {
    expect(validatePhase("destroy")).toBe(false);
  });
});

describe("validateForce", () => {
  it("accepts true or false only", () => {
    expect(validateForce("true")).toBe(true);
    expect(validateForce("false")).toBe(true);
    expect(validateForce("yes")).toBe(false);
  });
});

describe("validateRepoIdFormat", () => {
  it("accepts lowercase slug ids", () => {
    expect(validateRepoIdFormat("target-app")).toBe(true);
    expect(validateRepoIdFormat("real-target")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(validateRepoIdFormat("")).toBe(false);
    expect(validateRepoIdFormat("../etc")).toBe(false);
    expect(validateRepoIdFormat("Target-App")).toBe(false);
  });
});

describe("validateRepoId", () => {
  it("accepts configured repo ids", () => {
    const allowed = ["target-app", "real-target"] as const;
    expect(validateRepoId("target-app", allowed)).toBe(true);
    expect(validateRepoId("real-target", allowed)).toBe(true);
  });

  it("rejects unknown or malformed ids", () => {
    const allowed = ["target-app"] as const;
    expect(validateRepoId("unknown", allowed)).toBe(false);
    expect(validateRepoId("../etc", allowed)).toBe(false);
  });
});
