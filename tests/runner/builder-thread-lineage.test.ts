import { describe, expect, it } from "vitest";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";
import {
  BuilderThreadLineageError,
  resolveBuilderThreadMarkerEvidence,
  resolveBuilderThreadReference,
} from "../../src/runner/builder-thread-lineage.js";

const ORCHESTRATOR = "harness-orchestrator-v1";
const TARGET_REPO = "https://github.com/owner/example-target-app";
const PR_URL = "https://github.com/owner/example-target-app/pull/4";
const BRANCH = "cursor/wes-13";
const BUILDER_ID = "bc-builder-1";
const BUILDER_HASH = hashProviderIdentity(BUILDER_ID);

function markerComment(body: string, createdAt = "2026-07-07T10:00:00.000Z") {
  return { id: `comment-${Math.random()}`, body, createdAt };
}

function handoffMarker(
  agentIdOrHash: string,
  generation = 1,
  extra = "",
  useHash = false,
) {
  const identityLine = useHash
    ? `builder_agent_id_hash: ${agentIdOrHash}`
    : `builder_agent_id: ${agentIdOrHash}`;
  return `<!--\n${ORCHESTRATOR}\nphase: handoff\nrun_id: handoff-1\n${identityLine}\nbuilder_thread_generation: ${generation}\nbuilder_thread_action: created\nbuilder_origin_run_id: impl-1\ntarget_repo: ${TARGET_REPO}\npr_url: ${PR_URL}\nbranch: ${BRANCH}\n${extra}\n-->`;
}

function baseInput(
  comments: ReturnType<typeof markerComment>[],
  workflowState?: {
    builderAgentId?: string | null;
    builderRunId?: string | null;
    issueKey?: string;
  } | null,
) {
  return {
    comments,
    orchestratorMarker: ORCHESTRATOR,
    issueKey: "WES-13",
    targetRepo: TARGET_REPO,
    prUrl: PR_URL,
    branch: BRANCH,
    workflowState,
  };
}

describe("resolveBuilderThreadReference", () => {
  it("prefers explicit builder_agent_id on handoff markers", () => {
    const comments = [markerComment(handoffMarker(BUILDER_ID))];
    const reference = resolveBuilderThreadReference(baseInput(comments));
    expect(reference?.agentId).toBe(BUILDER_ID);
    expect(reference?.generation).toBe(1);
  });

  it("prefers private workflow state when no Linear candidates exist", () => {
    const reference = resolveBuilderThreadReference(
      baseInput([], {
        builderAgentId: BUILDER_ID,
        builderRunId: "impl-1",
        issueKey: "WES-13",
      }),
    );
    expect(reference?.agentId).toBe(BUILDER_ID);
    expect(reference?.originHarnessRunId).toBe("impl-1");
  });

  it("accepts hash markers when private state matches", () => {
    const comments = [markerComment(handoffMarker(BUILDER_HASH, 1, "", true))];
    const reference = resolveBuilderThreadReference(
      baseInput(comments, {
        builderAgentId: BUILDER_ID,
        builderRunId: "impl-1",
      }),
    );
    expect(reference?.agentId).toBe(BUILDER_ID);
  });

  it("fails closed when hash marker does not match private state", () => {
    const comments = [markerComment(handoffMarker(BUILDER_HASH, 1, "", true))];
    expect(() =>
      resolveBuilderThreadReference(
        baseInput(comments, {
          builderAgentId: "bc-other-agent",
          builderRunId: "impl-1",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ reason: "hash_state_mismatch" }),
    );
  });

  it("fails closed when legacy raw marker does not match private state", () => {
    const comments = [markerComment(handoffMarker("bc-marker-only"))];
    expect(() =>
      resolveBuilderThreadReference(
        baseInput(comments, {
          builderAgentId: BUILDER_ID,
          builderRunId: "impl-1",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ reason: "legacy_state_mismatch" }),
    );
  });

  it("throws missing_private_identity for hash-only markers without private state", () => {
    const comments = [markerComment(handoffMarker(BUILDER_HASH, 1, "", true))];
    expect(() => resolveBuilderThreadReference(baseInput(comments))).toThrowError(
      expect.objectContaining({ reason: "missing_private_identity" }),
    );
  });

  it("falls back to legacy implementation_start cursor_agent_id", () => {
    const comments = [
      markerComment(
        `<!--\n${ORCHESTRATOR}\nphase: implementation_start\nrun_id: impl-1\ncursor_agent_id: bc-legacy-1\ntarget_repo: ${TARGET_REPO}\nbranch: ${BRANCH}\n-->`,
      ),
    ];
    const reference = resolveBuilderThreadReference({
      comments,
      orchestratorMarker: ORCHESTRATOR,
      issueKey: "WES-13",
      targetRepo: TARGET_REPO,
      branch: BRANCH,
    });
    expect(reference?.agentId).toBe("bc-legacy-1");
  });

  it("selects the highest valid generation", () => {
    const comments = [
      markerComment(
        `<!--\n${ORCHESTRATOR}\nphase: revision\nrun_id: rev-1\nbuilder_agent_id: bc-builder-1\nbuilder_thread_generation: 1\nbuilder_thread_action: created\nbuilder_origin_run_id: impl-1\ntarget_repo: ${TARGET_REPO}\npr_url: ${PR_URL}\nbranch: ${BRANCH}\n-->`,
        "2026-07-07T09:00:00.000Z",
      ),
      markerComment(
        `<!--\n${ORCHESTRATOR}\nphase: revision\nrun_id: rev-2\nbuilder_agent_id: bc-builder-2\nbuilder_thread_generation: 2\nbuilder_thread_action: replaced\nbuilder_origin_run_id: impl-1\nprevious_builder_agent_id: bc-builder-1\ntarget_repo: ${TARGET_REPO}\npr_url: ${PR_URL}\nbranch: ${BRANCH}\n-->`,
        "2026-07-07T10:00:00.000Z",
      ),
    ];
    const reference = resolveBuilderThreadReference(baseInput(comments));
    expect(reference?.agentId).toBe("bc-builder-2");
    expect(reference?.generation).toBe(2);
  });

  it("returns null for mismatched PR lineage without throwing", () => {
    const comments = [markerComment(handoffMarker(BUILDER_ID))];
    const reference = resolveBuilderThreadReference({
      ...baseInput(comments),
      prUrl: "https://github.com/owner/example-target-app/pull/99",
    });
    expect(reference).toBeNull();
  });

  it("throws when highest-generation candidates disagree on agent id", () => {
    const comments = [
      markerComment(handoffMarker("bc-builder-1", 2), "2026-07-07T09:00:00.000Z"),
      markerComment(handoffMarker("bc-builder-2", 2), "2026-07-07T10:00:00.000Z"),
    ];
    expect(() => resolveBuilderThreadReference(baseInput(comments))).toThrow(
      BuilderThreadLineageError,
    );
    try {
      resolveBuilderThreadReference(baseInput(comments));
    } catch (error) {
      expect(error).toMatchObject({ reason: "conflicting_agent_ids" });
    }
  });

  it("throws conflicting_agent_ids when private state matches only one of two gen-2 markers", () => {
    const comments = [
      markerComment(handoffMarker("bc-builder-1", 2), "2026-07-07T09:00:00.000Z"),
      markerComment(handoffMarker("bc-builder-2", 2), "2026-07-07T10:00:00.000Z"),
    ];
    expect(() =>
      resolveBuilderThreadReference(
        baseInput(comments, {
          builderAgentId: "bc-builder-1",
          builderRunId: "impl-1",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ reason: "legacy_state_mismatch" }),
    );
  });

  it("throws on malformed generation instead of selecting an older candidate", () => {
    const comments = [
      markerComment(handoffMarker(BUILDER_ID, 2)),
      markerComment(
        handoffMarker("bc-builder-2").replace(
          "builder_thread_generation: 1",
          "builder_thread_generation: not-a-number",
        ),
      ),
    ];
    expect(() => resolveBuilderThreadReference(baseInput(comments))).toThrow(
      BuilderThreadLineageError,
    );
  });

  it("throws invalid_identity_hash_marker for uppercase hash on builder comments", () => {
    const uppercaseHash = BUILDER_HASH.toUpperCase();
    const comments = [
      markerComment(handoffMarker(uppercaseHash, 1, "", true)),
    ];
    expect(() => resolveBuilderThreadReference(baseInput(comments))).toThrowError(
      expect.objectContaining({ reason: "invalid_identity_hash_marker" }),
    );
  });

  it("excludes markers that do not link to previousImplementationRunId", () => {
    const comments = [markerComment(handoffMarker(BUILDER_ID))];
    const reference = resolveBuilderThreadReference({
      ...baseInput(comments),
      previousImplementationRunId: "impl-other",
    });
    expect(reference).toBeNull();
  });

  it("accepts markers linked through builder_origin_run_id", () => {
    const comments = [markerComment(handoffMarker(BUILDER_ID))];
    const reference = resolveBuilderThreadReference({
      ...baseInput(comments),
      previousImplementationRunId: "impl-1",
    });
    expect(reference?.agentId).toBe(BUILDER_ID);
  });

  it("returns private-state reference when no Linear candidates match context", () => {
    const comments = [markerComment(handoffMarker(BUILDER_ID))];
    const reference = resolveBuilderThreadReference({
      ...baseInput(comments, {
        builderAgentId: BUILDER_ID,
        builderRunId: "impl-private",
      }),
      prUrl: "https://github.com/owner/example-target-app/pull/99",
    });
    expect(reference?.agentId).toBe(BUILDER_ID);
    expect(reference?.originHarnessRunId).toBe("impl-private");
  });

  it("ignores spoofed ordinary user comments", () => {
    const comments = [
      markerComment("Please fix this.\n\ncursor_agent_id: bc-spoofed"),
    ];
    const reference = resolveBuilderThreadReference({
      comments,
      orchestratorMarker: ORCHESTRATOR,
      issueKey: "WES-13",
      targetRepo: TARGET_REPO,
    });
    expect(reference).toBeNull();
  });
});

describe("resolveBuilderThreadMarkerEvidence", () => {
  it("returns marker evidence for the canonical builder", () => {
    const comments = [
      markerComment(
        `<!--\n${ORCHESTRATOR}\nphase: revision_start\nrun_id: rev-1\nbuilder_agent_id: bc-builder-1\nbuilder_thread_generation: 1\nbuilder_thread_action: resumed\nbuilder_origin_run_id: impl-1\nbuilder_thread_idempotency_key: p-dev:revision:WES-13:fb-1\ntarget_repo: ${TARGET_REPO}\npr_url: ${PR_URL}\nbranch: ${BRANCH}\n-->`,
      ),
    ];
    const evidence = resolveBuilderThreadMarkerEvidence(baseInput(comments));
    expect(evidence).toEqual({
      builderAgentId: "bc-builder-1",
      builderThreadGeneration: 1,
      builderThreadAction: "resumed",
      builderOriginRunId: "impl-1",
      builderThreadIdempotencyKey: "p-dev:revision:WES-13:fb-1",
      previousBuilderAgentId: undefined,
      builderThreadReplacementReason: undefined,
    });
  });

  it("uses private workflow state identity for evidence when markers are hash-only", () => {
    const comments = [markerComment(handoffMarker(BUILDER_HASH, 2, "", true))];
    const evidence = resolveBuilderThreadMarkerEvidence(
      baseInput(comments, {
        builderAgentId: BUILDER_ID,
        builderRunId: "impl-1",
      }),
    );
    expect(evidence?.builderAgentId).toBe(BUILDER_ID);
    expect(evidence?.builderThreadGeneration).toBe(2);
  });
});
