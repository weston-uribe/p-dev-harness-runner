import { describe, expect, it, vi } from "vitest";
import {
  STOP_AFTER_PLANNING_LABEL,
  buildPlanningOnlyTerminalEffectIdentity,
  claimOrAdoptExecutionPolicyFreeze,
  computeExecutionPolicyIdentity,
  isPlanningOnlySuppressed,
  persistExecutionPolicyFreezeClaim,
  reconcilePlanningOnlyTerminalTransition,
  revalidateFrozenTerminalStatus,
  resolveAuthoritativeLinearDeliveryId,
  resolveCanceledTerminalStatus,
  resolveReservedExecutionPolicyLabels,
  ExecutionPolicyError,
  applyPlanningOnlySuccessTransition,
  completePlanningOnlyTerminalization,
  type ExecutionPolicyFreeze,
} from "../../src/workflow/execution-policy.js";
import {
  ensureImplementationDispatchPending,
  ensureImplementationJobDispatched,
} from "../../src/workflow/implementation-dispatch-effect.js";
import {
  ensurePlanReviewDispatchPending,
  ensurePlanReviewJobDispatched,
} from "../../src/workflow/plan-review-dispatch-effect.js";
import {
  buildImplementationSubjectIdentity,
  buildPlanReviewSubjectIdentity,
} from "../../src/workflow/subject-identities.js";
import { EXECUTION_POLICY_SCHEMA_VERSION } from "../../src/workflow/state/types.js";
import { InMemoryWorkflowStateStore, createEmptyWorkflowState } from "../../src/workflow/state/index.js";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/resolve.js";
import { migrateWorkflowConfigSection } from "../../src/config/migrate-workflow-config.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { createPlanArtifactIdentity } from "../../src/workflow/plan-artifact.js";

const TEAM_STATES = [
  { id: "state-canceled", name: "Canceled" },
  { id: "state-planning", name: "Planning" },
  { id: "state-ready", name: "Ready for Build" },
];

function baseIdentityInput(overrides: Record<string, string> = {}) {
  return {
    schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
    policyKind: "stop_after_planning" as const,
    linearTeamId: "team-1",
    issueInternalId: "issue-internal",
    issueKey: "FRE-1",
    sourceLabelId: "label-1",
    sourceLabelName: STOP_AFTER_PLANNING_LABEL,
    terminalStatusId: "state-canceled",
    terminalStatusName: "Canceled",
    workflowSchemaVersion: "product-development-v2",
    ...overrides,
  };
}

function claimStopAfterPlanningFreeze(
  overrides: Partial<{
    labels: Array<{ id: string; name: string }>;
    linearDeliveryId: string | null;
    firstPlanningRunId: string;
    teamStates: typeof TEAM_STATES;
  }> = {},
): ExecutionPolicyFreeze {
  const result = claimOrAdoptExecutionPolicyFreeze({
    issueKey: "FRE-1",
    issueInternalId: "issue-internal",
    linearTeamId: "team-1",
    labels: overrides.labels ?? [
      { id: "label-1", name: STOP_AFTER_PLANNING_LABEL },
    ],
    teamStates: overrides.teamStates ?? TEAM_STATES,
    workflowSchemaVersion: "product-development-v2",
    linearDeliveryId: overrides.linearDeliveryId ?? "dlv-1",
    firstPlanningRunId: overrides.firstPlanningRunId ?? "run-1",
    existingFreeze: null,
    existingResult: null,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  if (result.kind !== "claimed") {
    throw new Error(`expected claimed freeze, got ${result.kind}`);
  }
  return result.freeze;
}

function expectExecutionPolicyError(
  fn: () => unknown,
  code: ExecutionPolicyError["code"],
): void {
  try {
    fn();
    throw new Error(`expected ExecutionPolicyError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect((error as ExecutionPolicyError).code).toBe(code);
  }
}

describe("execution-policy", () => {
  it("returns none when no reserved labels are present", () => {
    const result = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "other", name: "bug" }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-1",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
    });
    expect(result.kind).toBe("none");
  });

  it("claims stop_after_planning when supported label is present", () => {
    const result = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-ingress",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.freeze.policyKind).toBe("stop_after_planning");
      expect(result.freeze.firstClaim.linearDeliveryId).toBe("dlv-ingress");
      expect(result.freeze.sourceLabelName).toBe(STOP_AFTER_PLANNING_LABEL);
    }
  });

  it("fails before mutation for unknown and multiple policy labels", () => {
    expect(() =>
      claimOrAdoptExecutionPolicyFreeze({
        issueKey: "FRE-1",
        issueInternalId: "issue-internal",
        linearTeamId: "team-1",
        labels: [{ id: "label-x", name: "p-dev-execution-policy:unknown" }],
        teamStates: TEAM_STATES,
        workflowSchemaVersion: "product-development-v2",
        linearDeliveryId: "dlv-1",
        firstPlanningRunId: "run-1",
        existingFreeze: null,
        existingResult: null,
      }),
    ).toThrow(ExecutionPolicyError);

    expect(() =>
      claimOrAdoptExecutionPolicyFreeze({
        issueKey: "FRE-1",
        issueInternalId: "issue-internal",
        linearTeamId: "team-1",
        labels: [
          { id: "label-1", name: STOP_AFTER_PLANNING_LABEL },
          { id: "label-2", name: "p-dev-execution-policy:other" },
        ],
        teamStates: TEAM_STATES,
        workflowSchemaVersion: "product-development-v2",
        linearDeliveryId: "dlv-1",
        firstPlanningRunId: "run-1",
        existingFreeze: null,
        existingResult: null,
      }),
    ).toThrow(ExecutionPolicyError);
  });

  it("computes stable policy identity independent of field order and delivery", () => {
    const a = computeExecutionPolicyIdentity(baseIdentityInput());
    const b = computeExecutionPolicyIdentity(
      baseIdentityInput({
        issueKey: "FRE-1",
        linearTeamId: "team-1",
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adopts existing freeze after label removal", () => {
    const claimed = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-1",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") {
      throw new Error("expected claimed");
    }

    const adopted = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: null,
      firstPlanningRunId: "run-2",
      existingFreeze: claimed.freeze,
      existingResult: null,
    });
    expect(adopted.kind).toBe("adopted");
    if (adopted.kind === "adopted") {
      expect(adopted.freeze.firstClaim.firstPlanningRunId).toBe("run-1");
      expect(adopted.freeze.policyIdentity).toBe(claimed.freeze.policyIdentity);
    }
  });

  it("rejects conflicting label after claim", () => {
    const freeze = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-1",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
    });
    if (freeze.kind !== "claimed") {
      throw new Error("expected claimed freeze");
    }

    expect(() =>
      claimOrAdoptExecutionPolicyFreeze({
        issueKey: "FRE-1",
        issueInternalId: "issue-internal",
        linearTeamId: "team-1",
        labels: [{ id: "label-2", name: "p-dev-execution-policy:other" }],
        teamStates: TEAM_STATES,
        workflowSchemaVersion: "product-development-v2",
        linearDeliveryId: null,
        firstPlanningRunId: "run-2",
        existingFreeze: freeze.freeze,
        existingResult: null,
      }),
    ).toThrow(ExecutionPolicyError);
  });

  it("requires ingress delivery id on first claim", () => {
    expect(() =>
      claimOrAdoptExecutionPolicyFreeze({
        issueKey: "FRE-1",
        issueInternalId: "issue-internal",
        linearTeamId: "team-1",
        labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
        teamStates: TEAM_STATES,
        workflowSchemaVersion: "product-development-v2",
        linearDeliveryId: null,
        firstPlanningRunId: "run-1",
        existingFreeze: null,
        existingResult: null,
      }),
    ).toThrow(ExecutionPolicyError);
  });

  it("fails when Canceled status is missing or ambiguous", () => {
    expect(() =>
      resolveCanceledTerminalStatus([{ id: "x", name: "Done" }]),
    ).toThrow(ExecutionPolicyError);

    expect(() =>
      resolveCanceledTerminalStatus([
        { id: "c1", name: "Canceled" },
        { id: "c2", name: "canceled" },
      ]),
    ).toThrow(ExecutionPolicyError);
  });

  it("normalizes reserved label matching case-insensitively", () => {
    const { supported } = resolveReservedExecutionPolicyLabels([
      { id: "label-1", name: " P-DEV-EXECUTION-POLICY:STOP-AFTER-PLANNING " },
    ]);
    expect(supported?.name).toBe(STOP_AFTER_PLANNING_LABEL);
  });

  it("persists freeze claim via CAS and completes terminalization sequence", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-99";
    const empty = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: { ...empty, stateRevision: 1 },
    });

    const claimed = claimOrAdoptExecutionPolicyFreeze({
      issueKey,
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-1",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected claimed");
    }

    const withFreeze = await persistExecutionPolicyFreezeClaim({
      store,
      issueKey,
      expectedRevision: 1,
      freeze: claimed.freeze,
    });
    expect(withFreeze.executionPolicyFreeze?.policyIdentity).toBe(
      claimed.freeze.policyIdentity,
    );

    const config = {
      workflow: migrateWorkflowConfigSection({} as HarnessConfig),
    } as HarnessConfig;
    const definition = resolveWorkflowDefinition({
      workflowConfig: config.workflow,
      effectiveOptionalPhases: { planReview: false, codeReview: false },
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: "## Plan\n\nStep 1",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: withFreeze.stateRevision + 1,
      supersedesPlanGenerationId: null,
      causedByReviewDecisionIdentity: null,
    });

    const { state: afterCas1, transition } =
      await applyPlanningOnlySuccessTransition({
        store,
        issueKey,
        definition,
        expectedStateRevision: withFreeze.stateRevision,
        freeze: claimed.freeze,
        planArtifact,
        planningRunId: "run-1",
        planningStatusName: "Planning",
      });
    expect(afterCas1.planningOnlyDownstreamSuppressed).toBe(true);
    expect(afterCas1.executionPolicyResult?.kind).toBe("terminalization_pending");
    expect(afterCas1.currentPhaseId).toBeNull();
    expect(transition?.reason).toBe("planning_only_terminalization_pending");
    expect(transition?.nextPhaseId).toBeNull();
    expect(transition?.bypass).toBeNull();
    expect(transition?.requiredAction).toBe("noop");

    const afterCas2 = await completePlanningOnlyTerminalization({
      store,
      issueKey,
      freeze: claimed.freeze,
      expectedStateRevision: afterCas1.stateRevision,
      now: () => "2026-01-02T00:00:00.000Z",
    });
    expect(afterCas2.executionPolicyResult?.kind).toBe("terminalized");
    expect(afterCas2.executionPolicyResult?.terminalizedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("isPlanningOnlySuppressed blocks downstream dispatch helpers", () => {
    const freeze = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-1",
      firstPlanningRunId: "run-1",
      existingFreeze: null,
      existingResult: null,
    });
    if (freeze.kind !== "claimed") {
      throw new Error("expected claimed");
    }

    const state = createEmptyWorkflowState({
      issueKey: "FRE-1",
      workflowSchemaVersion: "product-development-v2",
    });
    state.executionPolicyFreeze = freeze.freeze;
    state.planningOnlyDownstreamSuppressed = true;
    state.executionPolicyResult = {
      kind: "terminalization_pending",
      policyIdentity: freeze.freeze.policyIdentity,
      terminalStatusId: freeze.freeze.terminalStatusId,
    };

    expect(isPlanningOnlySuppressed(state)).toBe(true);
    expect(
      buildPlanningOnlyTerminalEffectIdentity(freeze.freeze.policyIdentity),
    ).toContain("planning_only_terminal_transition:");
  });

  it("resolveAuthoritativeLinearDeliveryId returns trimmed LINEAR_DELIVERY_ID", () => {
    expect(
      resolveAuthoritativeLinearDeliveryId({ LINEAR_DELIVERY_ID: "  dlv-abc  " }),
    ).toBe("dlv-abc");
    expect(resolveAuthoritativeLinearDeliveryId({})).toBeNull();
  });

  it("adopts when matching label is retained after claim", () => {
    const freeze = claimStopAfterPlanningFreeze();

    const adopted = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-different",
      firstPlanningRunId: "run-different",
      existingFreeze: freeze,
      existingResult: null,
    });

    expect(adopted.kind).toBe("adopted");
    if (adopted.kind === "adopted") {
      expect(adopted.freeze.policyIdentity).toBe(freeze.policyIdentity);
      expect(adopted.freeze.firstClaim.linearDeliveryId).toBe("dlv-1");
      expect(adopted.freeze.firstClaim.firstPlanningRunId).toBe("run-1");
    }
  });

  it("fails closed when multiple reserved labels are attached after claim", () => {
    const freeze = claimStopAfterPlanningFreeze();

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [
            { id: "label-1", name: STOP_AFTER_PLANNING_LABEL },
            { id: "label-2", name: "p-dev-execution-policy:other" },
          ],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "multiple_policy_labels",
    );
  });

  it("fails closed with conflicting_policy_label when unknown reserved label is added after claim", () => {
    const freeze = claimStopAfterPlanningFreeze();

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [{ id: "label-2", name: "p-dev-execution-policy:other" }],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "conflicting_policy_label",
    );
  });

  it("fails before provider mutation when frozen terminal status is invalidated", () => {
    const freeze = claimStopAfterPlanningFreeze();

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [],
          teamStates: [{ id: "state-done", name: "Done" }],
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "terminal_status_invalidated",
    );

    expectExecutionPolicyError(
      () =>
        revalidateFrozenTerminalStatus(
          [{ id: "state-canceled", name: "Canceled" }],
          freeze.terminalStatusId,
          ["Canceled"],
        ),
      "terminal_status_invalidated",
    );
  });

  it("returns already_terminalized for duplicate delivery without mutating claim metadata", () => {
    const freeze = claimStopAfterPlanningFreeze();
    const terminalized = {
      kind: "terminalized" as const,
      policyIdentity: freeze.policyIdentity,
      terminalStatusId: freeze.terminalStatusId,
      terminalizedAt: "2026-01-02T00:00:00.000Z",
      planningPhaseExecutionId: "run-1",
      planGenerationId: "plan-gen-1",
    };

    const duplicate = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-replay",
      firstPlanningRunId: "run-replay",
      existingFreeze: freeze,
      existingResult: terminalized,
    });

    expect(duplicate.kind).toBe("already_terminalized");
    if (duplicate.kind === "already_terminalized") {
      expect(duplicate.freeze.policyIdentity).toBe(freeze.policyIdentity);
      expect(duplicate.freeze.firstClaim.linearDeliveryId).toBe("dlv-1");
    }
  });

  it("rejects first claim without ingress delivery id", () => {
    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-1",
          existingFreeze: null,
          existingResult: null,
        }),
      "missing_ingress_identity",
    );
  });

  it("computes policy identity independent of delivery id, run id, and claim timestamps", () => {
    const freezeA = claimStopAfterPlanningFreeze({
      linearDeliveryId: "dlv-ingress-a",
      firstPlanningRunId: "run-a",
    });
    const adopted = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: "dlv-ingress-b",
      firstPlanningRunId: "run-b",
      existingFreeze: freezeA,
      existingResult: null,
      now: () => "2099-12-31T23:59:59.999Z",
    });
    if (adopted.kind !== "adopted") {
      throw new Error("expected adopted");
    }

    const identityFromFields = computeExecutionPolicyIdentity({
      schemaVersion: freezeA.schemaVersion,
      policyKind: freezeA.policyKind,
      linearTeamId: freezeA.linearTeamId,
      issueInternalId: freezeA.issueInternalId,
      issueKey: freezeA.issueKey,
      sourceLabelId: freezeA.sourceLabelId,
      sourceLabelName: freezeA.sourceLabelName,
      terminalStatusId: freezeA.terminalStatusId,
      terminalStatusName: freezeA.terminalStatusName,
      workflowSchemaVersion: freezeA.workflowSchemaVersion,
    });

    expect(adopted.freeze.policyIdentity).toBe(identityFromFields);
    expect(identityFromFields).toBe(freezeA.policyIdentity);
  });

  it("rejects Canceled terminal status when it is also a dispatch trigger", () => {
    expectExecutionPolicyError(
      () =>
        resolveCanceledTerminalStatus(
          [{ id: "state-canceled", name: "Canceled" }],
          ["Canceled", "Ready for Build"],
        ),
      "terminal_status_is_dispatch_trigger",
    );
  });

  it("reconciles pending terminalization after crash using frozen terminal status id", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-100";
    const empty = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: { ...empty, stateRevision: 1 },
    });

    const freeze = claimStopAfterPlanningFreeze();
    const withFreeze = await persistExecutionPolicyFreezeClaim({
      store,
      issueKey,
      expectedRevision: 1,
      freeze,
    });

    const config = {
      workflow: migrateWorkflowConfigSection({} as HarnessConfig),
    } as HarnessConfig;
    const definition = resolveWorkflowDefinition({
      workflowConfig: config.workflow,
      effectiveOptionalPhases: { planReview: false, codeReview: false },
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: "## Plan\n\nStep 1",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: withFreeze.stateRevision + 1,
      supersedesPlanGenerationId: null,
      causedByReviewDecisionIdentity: null,
    });

    const { state: afterCas1 } = await applyPlanningOnlySuccessTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: withFreeze.stateRevision,
      freeze,
      planArtifact,
      planningRunId: "run-1",
      planningStatusName: "Planning",
    });
    expect(afterCas1.executionPolicyResult?.kind).toBe("terminalization_pending");

    const transitionToTerminal = vi.fn().mockResolvedValue(undefined);
    const reconciled = await reconcilePlanningOnlyTerminalTransition({
      store,
      issueKey,
      freeze,
      currentStatusId: "state-planning",
      transitionToTerminal,
    });

    expect(transitionToTerminal).toHaveBeenCalledOnce();
    expect(reconciled.executionPolicyResult?.kind).toBe("terminalized");
    expect(reconciled.executionPolicyResult?.terminalStatusId).toBe(
      freeze.terminalStatusId,
    );
  });

  it("completes terminalization without second mutation when Linear already at frozen status", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-101";
    const empty = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: { ...empty, stateRevision: 1 },
    });

    const freeze = claimStopAfterPlanningFreeze();
    const withFreeze = await persistExecutionPolicyFreezeClaim({
      store,
      issueKey,
      expectedRevision: 1,
      freeze,
    });

    const config = {
      workflow: migrateWorkflowConfigSection({} as HarnessConfig),
    } as HarnessConfig;
    const definition = resolveWorkflowDefinition({
      workflowConfig: config.workflow,
      effectiveOptionalPhases: { planReview: false, codeReview: false },
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: "## Plan\n\nStep 1",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: withFreeze.stateRevision + 1,
      supersedesPlanGenerationId: null,
      causedByReviewDecisionIdentity: null,
    });

    const { state: afterCas1 } = await applyPlanningOnlySuccessTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: withFreeze.stateRevision,
      freeze,
      planArtifact,
      planningRunId: "run-1",
      planningStatusName: "Planning",
    });
    expect(afterCas1.executionPolicyResult?.kind).toBe("terminalization_pending");

    const transitionToTerminal = vi.fn().mockRejectedValue(
      new Error("Linear transition API failed"),
    );
    const reconciled = await reconcilePlanningOnlyTerminalTransition({
      store,
      issueKey,
      freeze,
      currentStatusId: freeze.terminalStatusId,
      transitionToTerminal,
    });

    expect(transitionToTerminal).not.toHaveBeenCalled();
    expect(reconciled.executionPolicyResult?.kind).toBe("terminalized");
  });

  it("requires exact ID and name agreement for attached reserved labels on adopt", () => {
    const freeze = claimStopAfterPlanningFreeze();

    // same name, different ID
    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [{ id: "label-recycled", name: STOP_AFTER_PLANNING_LABEL }],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "conflicting_policy_label",
    );

    // same ID, conflicting name
    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [
            { id: "label-1", name: "p-dev-execution-policy:other-policy" },
          ],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "conflicting_policy_label",
    );

    // exact same ID and name
    const adopted = claimOrAdoptExecutionPolicyFreeze({
      issueKey: "FRE-1",
      issueInternalId: "issue-internal",
      linearTeamId: "team-1",
      labels: [{ id: "label-1", name: STOP_AFTER_PLANNING_LABEL }],
      teamStates: TEAM_STATES,
      workflowSchemaVersion: "product-development-v2",
      linearDeliveryId: null,
      firstPlanningRunId: "run-2",
      existingFreeze: freeze,
      existingResult: null,
    });
    expect(adopted.kind).toBe("adopted");
  });

  it("fails closed on adopted freeze team, schema, and renamed terminal mismatches", () => {
    const freeze = claimStopAfterPlanningFreeze();

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-other",
          labels: [],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "unsupported_team",
    );

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v3",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: freeze,
          existingResult: null,
        }),
      "workflow_schema_mismatch",
    );

    expectExecutionPolicyError(
      () =>
        claimOrAdoptExecutionPolicyFreeze({
          issueKey: "FRE-1",
          issueInternalId: "issue-internal",
          linearTeamId: "team-1",
          labels: [],
          teamStates: TEAM_STATES,
          workflowSchemaVersion: "product-development-v2",
          linearDeliveryId: null,
          firstPlanningRunId: "run-2",
          existingFreeze: {
            ...freeze,
            schemaVersion: "p-dev.execution-policy.v0" as ExecutionPolicyFreeze["schemaVersion"],
          },
          existingResult: null,
        }),
      "policy_schema_mismatch",
    );

    expectExecutionPolicyError(
      () =>
        revalidateFrozenTerminalStatus(
          [{ id: "state-canceled", name: "Cancelled" }],
          freeze,
        ),
      "terminal_status_invalidated",
    );

    expectExecutionPolicyError(
      () =>
        revalidateFrozenTerminalStatus(
          [{ id: "state-canceled", name: "Canceled" }],
          freeze,
          ["Canceled"],
        ),
      "terminal_status_invalidated",
    );
  });

  it("proves planning-only success is one CAS with coherent transition metadata", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-102";
    const empty = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: { ...empty, stateRevision: 1 },
    });

    const freeze = claimStopAfterPlanningFreeze();
    const withFreeze = await persistExecutionPolicyFreezeClaim({
      store,
      issueKey,
      expectedRevision: 1,
      freeze,
    });

    const successfulWrites: Array<
      import("../../src/workflow/state/types.js").WorkflowStateRecord
    > = [];
    const originalCompareAndSet = store.compareAndSet.bind(store);
    store.compareAndSet = async (input) => {
      const saved = await originalCompareAndSet(input);
      if (saved) {
        successfulWrites.push(structuredClone(saved));
      }
      return saved;
    };

    const config = {
      workflow: migrateWorkflowConfigSection({} as HarnessConfig),
    } as HarnessConfig;
    const definition = resolveWorkflowDefinition({
      workflowConfig: config.workflow,
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: "## Plan\n\nStep 1",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: withFreeze.stateRevision + 1,
      supersedesPlanGenerationId: null,
      causedByReviewDecisionIdentity: null,
    });

    const writesBeforeSuccess = successfulWrites.length;
    const { state, transition } = await applyPlanningOnlySuccessTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: withFreeze.stateRevision,
      freeze,
      planArtifact,
      planningRunId: "run-1",
      planningStatusName: "Planning",
    });
    const successWrites = successfulWrites.slice(writesBeforeSuccess);

    expect(successWrites).toHaveLength(1);
    const persisted = successWrites[0]!;
    const downstreamPhases = new Set([
      "plan_review",
      "implementation",
      "implementation_dispatch",
      "planning_dispatch",
    ]);

    expect(persisted.planningOnlyDownstreamSuppressed).toBe(true);
    expect(persisted.executionPolicyResult?.kind).toBe("terminalization_pending");
    expect(persisted.latestPlanArtifact?.planGenerationId).toBe(
      planArtifact.planGenerationId,
    );
    expect(persisted.currentPhaseId).toBeNull();
    expect(persisted.planReviewSubjectIdentity ?? null).toBeNull();
    expect(persisted.implementationSubjectIdentity ?? null).toBeNull();
    expect(
      (persisted.sideEffects ?? []).filter(
        (effect) => effect.kind === "planning_only_terminal_transition",
      ),
    ).toHaveLength(1);
    expect(
      (persisted.sideEffects ?? []).some((effect) =>
        ["plan_review_dispatch", "implementation_dispatch"].includes(effect.kind),
      ),
    ).toBe(false);
    expect(persisted.lastTransitionIdentity).toMatch(
      /^planning_only_terminalization:/,
    );
    expect(persisted.lastTransitionIdentity).not.toMatch(/implementation/);
    expect(persisted.lastTransitionIdentity).not.toMatch(/plan_review/);

    expect(transition).not.toBeNull();
    expect(transition!.reason).toBe("planning_only_terminalization_pending");
    expect(transition!.nextPhaseId).toBeNull();
    expect(transition!.bypass).toBeNull();
    expect(transition!.requiredAction).toBe("noop");
    expect(transition!.idempotencyIdentity).toMatch(
      /^planning_only_terminalization:/,
    );

    expect(isPlanningOnlySuppressed(persisted)).toBe(true);
    expect(isPlanningOnlySuppressed(state)).toBe(true);
    expect(
      successWrites.filter(
        (snapshot) =>
          snapshot.latestPlanArtifact &&
          !snapshot.planningOnlyDownstreamSuppressed,
      ),
    ).toHaveLength(0);
    expect(
      [persisted.currentPhaseId, transition!.nextPhaseId].some(
        (phase) => phase != null && downstreamPhases.has(phase),
      ),
    ).toBe(false);

    const planReviewSubject = buildPlanReviewSubjectIdentity({
      issueKey,
      planGenerationId: planArtifact.planGenerationId,
      planHash: planArtifact.planArtifactHash,
      reviewCycle: 0,
    });
    const implementationSubject = buildImplementationSubjectIdentity({
      issueKey,
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      planGenerationId: planArtifact.planGenerationId,
      planArtifactHash: planArtifact.planArtifactHash,
      implementationCycle: 0,
    });

    const afterPlanReviewPending = await ensurePlanReviewDispatchPending({
      store,
      issueKey,
      reviewSubjectIdentity: planReviewSubject,
      state,
    });
    expect(afterPlanReviewPending.planReviewSubjectIdentity).toBeNull();
    const planReviewDispatch = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: planReviewSubject,
      ownerGeneration: "run-1",
      state,
    });
    expect(planReviewDispatch.httpDispatched).toBe(false);

    const afterImplementationPending = await ensureImplementationDispatchPending({
      store,
      issueKey,
      implementationSubjectIdentity: implementationSubject,
      state,
    });
    expect(afterImplementationPending.implementationSubjectIdentity).toBeNull();
    const implementationDispatch = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: implementationSubject,
      ownerGeneration: "run-1",
      state,
    });
    expect(implementationDispatch.httpDispatched).toBe(false);
  });

  it("reconcile at planning-only boundaries never dispatches downstream work", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-103";
    const empty = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
    });
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: { ...empty, stateRevision: 1 },
    });
    const freeze = claimStopAfterPlanningFreeze();
    const withFreeze = await persistExecutionPolicyFreezeClaim({
      store,
      issueKey,
      expectedRevision: 1,
      freeze,
    });
    const config = {
      workflow: migrateWorkflowConfigSection({} as HarnessConfig),
    } as HarnessConfig;
    const definition = resolveWorkflowDefinition({
      workflowConfig: config.workflow,
      effectiveOptionalPhases: { planReview: false, codeReview: false },
    });
    const planArtifact = createPlanArtifactIdentity({
      planBody: "## Plan\n\nStep 1",
      plannerRunId: "run-1",
      promptContractVersion: "planning@1",
      workflowStateRevision: withFreeze.stateRevision + 1,
      supersedesPlanGenerationId: null,
      causedByReviewDecisionIdentity: null,
    });

    const assertNoDownstream = async (
      state: import("../../src/workflow/state/types.js").WorkflowStateRecord,
    ) => {
      if (!isPlanningOnlySuppressed(state) && !state.latestPlanArtifact) {
        return;
      }
      if (state.latestPlanArtifact) {
        expect(isPlanningOnlySuppressed(state)).toBe(true);
      }
      const planReviewSubject = buildPlanReviewSubjectIdentity({
        issueKey,
        planGenerationId:
          state.latestPlanArtifact?.planGenerationId ??
          planArtifact.planGenerationId,
        planHash:
          state.latestPlanArtifact?.planArtifactHash ??
          planArtifact.planArtifactHash,
        reviewCycle: 0,
      });
      const implementationSubject = buildImplementationSubjectIdentity({
        issueKey,
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "main",
        planGenerationId:
          state.latestPlanArtifact?.planGenerationId ??
          planArtifact.planGenerationId,
        planArtifactHash:
          state.latestPlanArtifact?.planArtifactHash ??
          planArtifact.planArtifactHash,
        implementationCycle: 0,
      });
      const pr = await ensurePlanReviewJobDispatched({
        store,
        issueKey,
        reviewSubjectIdentity: planReviewSubject,
        ownerGeneration: "run-1",
        state,
      });
      const impl = await ensureImplementationJobDispatched({
        store,
        issueKey,
        implementationSubjectIdentity: implementationSubject,
        ownerGeneration: "run-1",
        state,
      });
      expect(pr.httpDispatched).toBe(false);
      expect(impl.httpDispatched).toBe(false);
    };

    // before CAS1
    await assertNoDownstream(withFreeze);

    const { state: afterCas1 } = await applyPlanningOnlySuccessTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: withFreeze.stateRevision,
      freeze,
      planArtifact,
      planningRunId: "run-1",
      planningStatusName: "Planning",
    });
    // immediately after CAS1 / before Linear
    await assertNoDownstream(afterCas1);

    const transitionToTerminal = vi.fn().mockResolvedValue(undefined);
    // after remote transition but before CAS2 — still pending
    await assertNoDownstream(afterCas1);
    const afterCas2 = await reconcilePlanningOnlyTerminalTransition({
      store,
      issueKey,
      freeze,
      currentStatusId: freeze.terminalStatusId,
      transitionToTerminal,
    });
    await assertNoDownstream(afterCas2);
    expect(afterCas2.executionPolicyResult?.kind).toBe("terminalized");
    expect(transitionToTerminal).not.toHaveBeenCalled();
  });
});
