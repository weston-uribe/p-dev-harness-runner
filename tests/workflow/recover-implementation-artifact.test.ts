import { describe, expect, it } from "vitest";
import { formatHandoffComment } from "../../src/linear/comments.js";
import { parseHarnessMarkers } from "../../src/linear/markers.js";
import { hashDiffIdentity } from "../../src/workflow/implementation-artifact.js";
import {
  buildRecoveredImplementationArtifact,
  recoverPrLocatorFromHandoffComments,
} from "../../src/workflow/recover-implementation-artifact.js";

const ORCHESTRATOR = "harness-orchestrator-v1";
const PR_URL =
  "https://github.com/weston-uribe/weston-uribe-portfolio/pull/42";
const TARGET = "https://github.com/weston-uribe/weston-uribe-portfolio";

describe("recoverPrLocatorFromHandoffComments", () => {
  it("recovers PR locator from marker-backed handoff comments", () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const diffHash = hashDiffIdentity({
      prNumber: 42,
      headSha,
      baseSha,
    });
    const comment = formatHandoffComment("Ready for review.", {
      orchestratorMarker: ORCHESTRATOR,
      phase: "handoff",
      runId: "handoff-run-1",
      model: "composer-2.5",
      promptVersion: "handoff@1",
      targetRepo: TARGET,
      baseBranch: "dev",
      branch: "cursor/tt-4-example",
      prUrl: PR_URL,
      implementationGenerationId: "impl-abc",
      prNumber: "42",
      prHeadSha: headSha,
      prBaseSha: baseSha,
      diffHash,
    });

    const locator = recoverPrLocatorFromHandoffComments({
      comments: [{ body: comment }],
      orchestratorMarker: ORCHESTRATOR,
      targetRepository: TARGET,
    });

    expect(locator).not.toBeNull();
    expect(locator?.prNumber).toBe(42);
    expect(locator?.prUrl).toBe(PR_URL);
    expect(locator?.implementationGenerationId).toBe("impl-abc");
    expect(locator?.headSha).toBe(headSha);
    expect(parseHarnessMarkers(comment).implementationGenerationId).toBe(
      "impl-abc",
    );

    const artifact = buildRecoveredImplementationArtifact({
      locator: locator!,
      headSha,
      baseSha,
    });
    expect(artifact.implementationGenerationId).toBe("impl-abc");
    expect(artifact.headSha).toBe(headSha);
    expect(artifact.diffHash).toBe(diffHash);
  });

  it("prefers live GitHub SHAs when handoff markers are stale after Code Revision", () => {
    const staleHead = "a".repeat(40);
    const staleBase = "b".repeat(40);
    const liveHead = "e".repeat(40);
    const liveBase = "f".repeat(40);
    const comment = formatHandoffComment("Ready for review.", {
      orchestratorMarker: ORCHESTRATOR,
      phase: "handoff",
      runId: "handoff-run-stale",
      model: "composer-2.5",
      promptVersion: "handoff@1",
      targetRepo: TARGET,
      prUrl: PR_URL,
      implementationGenerationId: "impl-stale",
      prNumber: "42",
      prHeadSha: staleHead,
      prBaseSha: staleBase,
      diffHash: hashDiffIdentity({
        prNumber: 42,
        headSha: staleHead,
        baseSha: staleBase,
      }),
    });
    const locator = recoverPrLocatorFromHandoffComments({
      comments: [{ body: comment }],
      orchestratorMarker: ORCHESTRATOR,
      targetRepository: TARGET,
    });
    const artifact = buildRecoveredImplementationArtifact({
      locator: locator!,
      headSha: liveHead,
      baseSha: liveBase,
    });
    expect(artifact.headSha).toBe(liveHead);
    expect(artifact.baseSha).toBe(liveBase);
    expect(artifact.diffHash).toBe(
      hashDiffIdentity({ prNumber: 42, headSha: liveHead, baseSha: liveBase }),
    );
    expect(artifact.implementationGenerationId).toMatch(/^impl-recovered-/);
    expect(artifact.implementationGenerationId).not.toBe("impl-stale");
  });

  it("derives stable identity when markers lack generation/sha fields (legacy)", () => {
    const comment = formatHandoffComment("Ready for review.", {
      orchestratorMarker: ORCHESTRATOR,
      phase: "handoff",
      runId: "handoff-run-legacy",
      model: "composer-2.5",
      promptVersion: "handoff@1",
      targetRepo: TARGET,
      prUrl: PR_URL,
      branch: "cursor/tt-4-example",
    });

    expect(parseHarnessMarkers(comment).implementationGenerationId).toBeUndefined();

    const locator = recoverPrLocatorFromHandoffComments({
      comments: [{ body: comment }],
      orchestratorMarker: ORCHESTRATOR,
      targetRepository: TARGET,
    });
    expect(locator?.prNumber).toBe(42);
    expect(locator?.builderRunId).toBe("handoff-run-legacy");

    const headSha = "c".repeat(40);
    const baseSha = "d".repeat(40);
    const first = buildRecoveredImplementationArtifact({
      locator: locator!,
      headSha,
      baseSha,
    });
    const second = buildRecoveredImplementationArtifact({
      locator: locator!,
      headSha,
      baseSha,
    });
    expect(first.implementationGenerationId).toMatch(/^impl-recovered-/);
    expect(first.implementationGenerationId).toBe(
      second.implementationGenerationId,
    );
    expect(first.headSha).toBe(headSha);
    expect(first.diffHash).toBe(
      hashDiffIdentity({ prNumber: 42, headSha, baseSha }),
    );
  });

  it("returns null when no handoff PR comment exists", () => {
    const locator = recoverPrLocatorFromHandoffComments({
      comments: [
        {
          body: "planning only\n\n<!--\nharness-orchestrator-v1\nphase: planning\nrun_id: x\nmodel: m\nprompt_version: p\ntarget_repo: r\n-->",
        },
      ],
      orchestratorMarker: ORCHESTRATOR,
      targetRepository: TARGET,
    });
    expect(locator).toBeNull();
  });
});
