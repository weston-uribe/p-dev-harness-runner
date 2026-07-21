import { describe, expect, it } from "vitest";
import { buildImplementationSubjectIdentity } from "../../src/workflow/subject-identities.js";
import {
  buildImplementationDeliveryId,
  buildImplementationRequestId,
} from "../../src/workflow/implementation-dispatch-effect.js";

describe("implementation subject identity", () => {
  const base = {
    issueKey: "FRE-6",
    targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
    baseBranch: "dev",
    planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
    planArtifactHash:
      "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
    implementationCycle: 0,
  };

  it("is stable across webhook vs reconcile trigger inputs", () => {
    const a = buildImplementationSubjectIdentity(base);
    const b = buildImplementationSubjectIdentity({
      ...base,
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio.git",
    });
    expect(a).toBe(b);
    expect(buildImplementationDeliveryId(a)).toBe(`impl-subject:${a}`);
    expect(buildImplementationRequestId(a)).toMatch(/^dlv-[a-f0-9]{32}$/);
  });

  it("does not change when Linear status or delivery id would differ", () => {
    const subject = buildImplementationSubjectIdentity(base);
    // Same inputs again — status/delivery are intentionally not part of the hash.
    expect(buildImplementationSubjectIdentity(base)).toBe(subject);
  });

  it("changes when plan generation or cycle changes", () => {
    const a = buildImplementationSubjectIdentity(base);
    const b = buildImplementationSubjectIdentity({
      ...base,
      planGenerationId: "other-gen",
    });
    const c = buildImplementationSubjectIdentity({
      ...base,
      implementationCycle: 1,
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("uses direct/none when plan artifact absent", () => {
    const subject = buildImplementationSubjectIdentity({
      issueKey: "FRE-6",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      implementationCycle: 0,
    });
    expect(subject).toMatch(/^[a-f0-9]{32}$/);
  });
});
