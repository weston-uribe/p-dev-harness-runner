import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";
import {
  applyWorkflowTransition,
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
} from "../../src/workflow/state/index.js";

const definition = resolveWorkflowDefinition({
  workflowConfig: {
    optionalPhases: { planReview: false, codeReview: true },
  },
});

const LEASE_IDENTITY = "implementation:FRE-LEASE-HANDOFF";
const OWNER_RUN_ID = "impl-run-owner";
const WRONG_OWNER = "other-run";

function seedHandoffWithImplementationLease(store: InMemoryWorkflowStateStore) {
  const issueKey = "FRE-LEASE-HANDOFF";
  store.seed({
    ...createEmptyWorkflowState({
      issueKey,
      workflowSchemaVersion: definition.schemaVersion,
      enabledOptionalPhases: { planReview: false, codeReview: true },
      effectiveOptionalPhases: { planReview: false, codeReview: true },
    }),
    stateRevision: 1,
    currentPhaseId: "handoff",
    activeRunIdentities: [LEASE_IDENTITY],
    activeRunLease: {
      identity: LEASE_IDENTITY,
      ownerRunId: OWNER_RUN_ID,
      phaseId: "implementation",
      subjectIdentity: LEASE_IDENTITY,
      acquiredAt: "2026-07-21T10:00:00.000Z",
      expiresAt: "2026-07-21T10:45:00.000Z",
      heartbeatAt: "2026-07-21T10:00:00.000Z",
    },
  });
  return issueKey;
}

describe("handoff clearActiveRunLease", () => {
  it("clears implementation lease when identity and owner match", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = seedHandoffWithImplementationLease(store);

    const applied = await applyWorkflowTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "handoff",
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: "handoff-run-1",
      },
      evidence: { linearStatusName: "PR Open" },
      clearActiveRunLease: {
        expectedIdentity: LEASE_IDENTITY,
        expectedOwnerRunId: OWNER_RUN_ID,
      },
    });

    expect(applied.ok).toBe(true);
    expect(applied.state?.activeRunLease).toBeNull();
    expect(applied.state?.activeRunIdentities).toEqual([]);
  });

  it("does not clear implementation lease when owner mismatches", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = seedHandoffWithImplementationLease(store);

    const applied = await applyWorkflowTransition({
      store,
      issueKey,
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "handoff",
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: "handoff-run-2",
      },
      evidence: { linearStatusName: "PR Open" },
      clearActiveRunLease: {
        expectedIdentity: LEASE_IDENTITY,
        expectedOwnerRunId: WRONG_OWNER,
      },
    });

    expect(applied.ok).toBe(true);
    expect(applied.state?.activeRunLease?.ownerRunId).toBe(OWNER_RUN_ID);
    expect(applied.state?.activeRunIdentities).toEqual([LEASE_IDENTITY]);
  });
});
