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

    const afterCas1 = await applyPlanningOnlySuccessTransition({
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

    const afterCas1 = await applyPlanningOnlySuccessTransition({
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

    const afterCas1 = await applyPlanningOnlySuccessTransition({
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

  it("suppresses plan review and implementation dispatch between CAS1 and CAS2", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-102";
    const base = createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: "product-development-v2",
      effectiveOptionalPhases: { planReview: true, codeReview: false },
    });
    const freeze = claimStopAfterPlanningFreeze();
    const planGenerationId = "120aa5ff-005a-44e7-aa5a-0b4922d951b4";
    const planHash =
      "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6";
    const planReviewSubject = buildPlanReviewSubjectIdentity({
      issueKey,
      planGenerationId,
      planHash,
      reviewCycle: 0,
    });
    const implementationSubject = buildImplementationSubjectIdentity({
      issueKey,
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      planGenerationId,
      planArtifactHash: planHash,
      implementationCycle: 0,
    });

    let state: import("../../src/workflow/state/types.js").WorkflowStateRecord = {
      ...base,
      stateRevision: 1,
      executionPolicyFreeze: freeze,
      planningOnlyDownstreamSuppressed: true,
      executionPolicyResult: {
        kind: "terminalization_pending",
        policyIdentity: freeze.policyIdentity,
        terminalStatusId: freeze.terminalStatusId,
        planningPhaseExecutionId: "run-1",
        planGenerationId,
      },
      latestPlanArtifact: {
        planGenerationId,
        planArtifactHash: planHash,
        plannerRunId: "run-1",
        promptContractVersion: "planning@1",
        workflowStateRevision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        supersedesPlanGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
    };
    store.seed(state);

    expect(isPlanningOnlySuppressed(state)).toBe(true);

    const afterPlanReviewPending = await ensurePlanReviewDispatchPending({
      store,
      issueKey,
      reviewSubjectIdentity: planReviewSubject,
      state,
    });
    expect(afterPlanReviewPending).toBe(state);
    expect(afterPlanReviewPending.planReviewSubjectIdentity).toBeNull();

    const planReviewDispatch = await ensurePlanReviewJobDispatched({
      store,
      issueKey,
      reviewSubjectIdentity: planReviewSubject,
      ownerGeneration: "run-1",
      state,
    });
    expect(planReviewDispatch.outcome).toBe("already_dispatched");
    expect(planReviewDispatch.httpDispatched).toBe(false);

    const afterImplementationPending = await ensureImplementationDispatchPending({
      store,
      issueKey,
      implementationSubjectIdentity: implementationSubject,
      state,
    });
    expect(afterImplementationPending).toBe(state);
    expect(afterImplementationPending.implementationSubjectIdentity).toBeNull();

    const implementationDispatch = await ensureImplementationJobDispatched({
      store,
      issueKey,
      implementationSubjectIdentity: implementationSubject,
      ownerGeneration: "run-1",
      state,
    });
    expect(implementationDispatch.outcome).toBe("already_dispatched");
    expect(implementationDispatch.httpDispatched).toBe(false);
  });
});
