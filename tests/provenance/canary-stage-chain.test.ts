import { describe, expect, it } from "vitest";
import {
  buildCanaryAttemptRootRecord,
  buildCanaryAttemptTransitionRecord,
  deriveCanaryStageChainState,
} from "../../src/provenance/canary-stage-chain.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";

const BASE = {
  recoveryOperationId: "11111111-1111-4111-8111-111111111111",
  epochId: "epoch-canary-1",
  stage: "required_canary",
};

describe("canary stage chain", () => {
  it("derives active ordinal from transitions without mutable field", () => {
    const attempt1 = buildCanaryAttemptRootRecord({
      ...BASE,
      ordinal: 1,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const transitions = [
      buildCanaryAttemptTransitionRecord({
        ...BASE,
        ordinal: 1,
        transitionId: "t1",
        transitionKind: "issue_create_intent",
        recordedAt: "2026-07-24T00:00:00.000Z",
      }),
      buildCanaryAttemptTransitionRecord({
        ...BASE,
        ordinal: 1,
        transitionId: "t2",
        transitionKind: "issue_created",
        recordedAt: "2026-07-24T00:01:00.000Z",
      }),
    ];
    const state = deriveCanaryStageChainState({
      stageRoot: null,
      attemptRoots: [attempt1],
      transitions,
    });
    expect(state.activeOrdinal).toBe(1);
    expect(state.finalOrdinal).toBeNull();
  });

  it("requires replacement authorization before ordinal 2", () => {
    const attempt1 = buildCanaryAttemptRootRecord({
      ...BASE,
      ordinal: 1,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const attempt2 = buildCanaryAttemptRootRecord({
      ...BASE,
      ordinal: 2,
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(() =>
      deriveCanaryStageChainState({
        stageRoot: null,
        attemptRoots: [attempt1, attempt2],
        transitions: [
          buildCanaryAttemptTransitionRecord({
            ...BASE,
            ordinal: 1,
            transitionId: "fail",
            transitionKind: "observe_terminal_failure",
            recordedAt: "2026-07-24T01:00:00.000Z",
          }),
        ],
      }),
    ).toThrow(CursorProvenanceError);
  });

  it("allows ordinal 2 after replacement_authorized", () => {
    const attempt1 = buildCanaryAttemptRootRecord({
      ...BASE,
      ordinal: 1,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const attempt2 = buildCanaryAttemptRootRecord({
      ...BASE,
      ordinal: 2,
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const state = deriveCanaryStageChainState({
      stageRoot: null,
      attemptRoots: [attempt1, attempt2],
      transitions: [
        buildCanaryAttemptTransitionRecord({
          ...BASE,
          ordinal: 1,
          transitionId: "fail",
          transitionKind: "observe_terminal_failure",
          recordedAt: "2026-07-24T01:00:00.000Z",
        }),
        buildCanaryAttemptTransitionRecord({
          ...BASE,
          ordinal: 1,
          transitionId: "auth",
          transitionKind: "replacement_authorized",
          recordedAt: "2026-07-24T01:05:00.000Z",
        }),
      ],
    });
    expect(state.finalOrdinal).toBeNull();
    expect(state.activeOrdinal).toBe(2);
    expect(state.attemptRoots).toHaveLength(2);
  });
});
