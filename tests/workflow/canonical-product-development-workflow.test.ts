import { describe, expect, it } from "vitest";
import {
  CANONICAL_AGENT_PHASES,
  CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
  CANONICAL_HUMAN_GATES,
  CANONICAL_STATUSES,
  DEPRECATED_CANONICAL_STATUS_NAMES,
  DUPLICATE_STATUS_CONTRACT,
  getCreatableCanonicalStatuses,
  getDefaultCanonicalLayout,
  getEffectiveCanonicalTransitions,
  getEffectiveMergeTransitions,
  getPreflightRequiredCanonicalStatuses,
  isCanonicalDispatchTriggerStatusName,
  lookupCanonicalStatus,
  lookupCanonicalStatusByExactName,
  lookupCanonicalStatusByName,
  resolveMergePathVariant,
} from "../../src/workflow/canonical-product-development-workflow.js";

describe("canonical product development workflow descriptor", () => {
  it("defines exactly four human-owned bridge dispatch trigger statuses", () => {
    expect(CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES).toEqual([
      "Ready for Planning",
      "Ready for Build",
      "Needs Revision",
      "Ready to Merge",
    ]);
    expect(CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES).not.toContain("PR Open");
    const triggerStatuses = CANONICAL_STATUSES.filter(
      (status) => status.automationTrigger,
    );
    expect(triggerStatuses).toHaveLength(4);
    expect(triggerStatuses.map((status) => status.name)).toEqual([
      ...CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
    ]);
    expect(lookupCanonicalStatus("pr-open")?.automationTrigger).toBe(false);
  });

  it("models Plan Review as an optional canonical status", () => {
    expect(DEPRECATED_CANONICAL_STATUS_NAMES).not.toContain("Plan Review");
    const planReview = lookupCanonicalStatus("plan-review");
    expect(planReview?.name).toBe("Plan Review");
    expect(planReview?.optionalPhase).toBe(true);

    const preflightRequired = getPreflightRequiredCanonicalStatuses();
    expect(preflightRequired.some((status) => status.key === "plan-review")).toBe(
      false,
    );
  });

  it("models Duplicate as optional system terminal that does not block preflight", () => {
    expect(DUPLICATE_STATUS_CONTRACT.requiredForPreflight).toBe(false);
    expect(DUPLICATE_STATUS_CONTRACT.creatable).toBe(false);
    expect(DUPLICATE_STATUS_CONTRACT.systemManaged).toBe(true);

    const duplicate = lookupCanonicalStatus("duplicate");
    expect(duplicate?.role).toBe("system-managed");
    expect(duplicate?.creatable).toBe(false);

    const preflightRequired = getPreflightRequiredCanonicalStatuses();
    expect(preflightRequired.some((status) => status.key === "duplicate")).toBe(
      false,
    );
  });

  it("represents PM Review as human gate only", () => {
    const pmReview = lookupCanonicalStatus("pm-review");
    expect(pmReview?.role).toBe("human-gate");
    expect(pmReview?.actorRole).toBe("human-gate");
    expect(pmReview?.agentPhaseKey).toBeUndefined();
    expect(pmReview?.automationTrigger).toBe(false);
  });

  it("represents Engineering Review as human gate only", () => {
    const engReview = lookupCanonicalStatus("engineering-review");
    expect(engReview?.role).toBe("human-gate");
    expect(engReview?.actorRole).toBe("human-gate");
    expect(engReview?.agentPhaseKey).toBeUndefined();
    expect(engReview?.automationTrigger).toBe(false);
  });

  it("defines explicit human transitions", () => {
    const backlog = CANONICAL_HUMAN_GATES.find((gate) => gate.statusKey === "backlog");
    expect(backlog?.allowedDestinations).toEqual([
      "ready-for-planning",
      "ready-for-build",
    ]);

    const pmReview = CANONICAL_HUMAN_GATES.find(
      (gate) => gate.statusKey === "pm-review",
    );
    expect(pmReview?.allowedDestinations).toEqual([
      "needs-revision",
      "engineering-review",
    ]);

    const engReview = CANONICAL_HUMAN_GATES.find(
      (gate) => gate.statusKey === "engineering-review",
    );
    expect(engReview?.allowedDestinations).toEqual([
      "needs-revision",
      "ready-to-merge",
    ]);
  });

  it("routes revision success to PM Review, not PR Open", () => {
    const revision = CANONICAL_AGENT_PHASES.find((phase) => phase.key === "revision");
    expect(revision?.successDestinationKey).toBe("pm-review");
    expect(revision?.successDestinationKey).not.toBe("pr-open");
  });

  it("resolves repository-specific merge paths", () => {
    expect(
      resolveMergePathVariant({ baseBranch: "main", productionBranch: "main" }),
    ).toBe("direct-production");
    expect(
      resolveMergePathVariant({ baseBranch: "dev", productionBranch: "main" }),
    ).toBe("integration-then-production");

    const direct = getEffectiveMergeTransitions({
      baseBranch: "main",
      productionBranch: "main",
    });
    expect(direct).toEqual([
      expect.objectContaining({
        from: "merging",
        to: "merged-deployed",
        kind: "success",
      }),
    ]);
    expect(direct.some((transition) => transition.to === "merged-to-dev")).toBe(
      false,
    );

    const branching = getEffectiveMergeTransitions({
      baseBranch: "dev",
      productionBranch: "main",
    });
    expect(branching.map((transition) => transition.to)).toEqual([
      "merged-to-dev",
      "merged-deployed",
    ]);
  });

  it("does not embed source filenames or function names in descriptor exports", () => {
    const serialized = JSON.stringify({
      statuses: CANONICAL_STATUSES,
      phases: CANONICAL_AGENT_PHASES,
    });
    expect(serialized).not.toMatch(/\.ts|\.js|execute[A-Z]|src\//);
  });

  it("provides default layout keyed by canonical status keys", () => {
    const layout = getDefaultCanonicalLayout();
    expect(Object.keys(layout)).toEqual(CANONICAL_STATUSES.map((status) => status.key));
  });

  it("includes production sync as system transition for branching repos", () => {
    const transitions = getEffectiveCanonicalTransitions({
      baseBranch: "dev",
      productionBranch: "main",
    });
    expect(transitions).toContainEqual(
      expect.objectContaining({
        from: "merged-to-dev",
        to: "merged-deployed",
        kind: "system",
      }),
    );
  });

  it("matches creatable statuses excluding Duplicate", () => {
    const creatable = getCreatableCanonicalStatuses();
    expect(creatable.every((status) => status.creatable)).toBe(true);
    expect(creatable.some((status) => status.key === "duplicate")).toBe(false);
  });

  it("recognizes dispatch trigger status names case-insensitively", () => {
    expect(isCanonicalDispatchTriggerStatusName("ready for build")).toBe(true);
    expect(isCanonicalDispatchTriggerStatusName("PM Review")).toBe(false);
  });

  it("looks up statuses by exact canonical name only in authoritative helper", () => {
    expect(lookupCanonicalStatusByExactName("Merged / Deployed")?.key).toBe(
      "merged-deployed",
    );
    expect(lookupCanonicalStatusByExactName("merged / deployed")).toBeUndefined();
  });

  it("looks up statuses case-insensitively only in non-authoritative helper", () => {
    expect(lookupCanonicalStatusByName("Merged / Deployed")?.key).toBe(
      "merged-deployed",
    );
    expect(lookupCanonicalStatusByName("merged / deployed")?.key).toBe(
      "merged-deployed",
    );
  });
});
