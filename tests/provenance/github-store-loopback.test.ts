import { describe, expect, it, vi } from "vitest";
import {
  GithubProvenanceEventStore,
} from "../../src/provenance/store.js";
import { GitHubApiError } from "../../src/github/client.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";
import { buildLaunchIntentEvent } from "../../src/provenance/events.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import { computeLaunchAttemptId } from "../../src/provenance/launch-attempt-id.js";
import { provenanceEventRemotePath } from "../../src/provenance/paths.js";

function ctx() {
  return createLinearHarnessLaunchContext({
    operatorWorkspaceId: "ws",
    sourceProjectId: "proj",
    linearIssueId: "id-1",
    linearIssueKey: "WES-9",
    phase: "planning",
    phaseExecutionId: "run-9",
    harnessRunId: "run-9",
    providerOperationId: allocateProviderOperationId({
      issueKey: "WES-9",
      phase: "planning",
      harnessRunId: "run-9",
      agentRole: "planner",
      action: "create",
      generation: 1,
      launchSurface: "planning.create",
      operationOrdinal: 1,
    }),
    agentRole: "planner",
    action: "create",
    generation: 1,
    priorAgentHash: null,
    targetRepository: "https://github.com/o/r",
    startingRef: "main",
    prUrl: null,
    prNumber: null,
    orchestratorMarker: "harness-orchestrator-v1",
    orchestratorMarkerVersion: "v1",
    sourceRepositorySha: "s".repeat(40),
    runnerSnapshotVersion: "r1",
    workflowRunId: null,
    launchSurface: "planning.create",
  });
}

describe("GithubProvenanceEventStore loopback", () => {
  it("validates branch exists and does not auto-create when disabled", async () => {
    const getGitRef = vi.fn(async () => {
      throw new GitHubApiError(404, "missing");
    });
    const createGitRef = vi.fn();
    const store = new GithubProvenanceEventStore({
      client: { getGitRef, createGitRef } as never,
      owner: "o",
      repo: "r",
      branch: "p-dev-runtime-state",
      autoCreateBranch: false,
    });
    await expect(store.assertBranchExists()).rejects.toBeInstanceOf(
      CursorProvenanceError,
    );
    expect(createGitRef).not.toHaveBeenCalled();
  });

  it("create-only write, identical retry, divergent retry, private commit message", async () => {
    const files = new Map<string, string>();
    const createOrUpdateRepositoryFile = vi.fn(
      async (input: {
        path: string;
        message: string;
        content: string;
      }) => {
        if (files.has(input.path)) {
          throw new GitHubApiError(422, "exists");
        }
        expect(input.message).not.toMatch(/bc-|agent-|run-[0-9a-f]{8}/i);
        files.set(input.path, input.content);
        return { commitSha: "abc".padEnd(40, "0") };
      },
    );
    const getRepositoryContent = vi.fn(
      async (_o: string, _r: string, path: string) => {
        const content = files.get(path);
        if (!content) return null;
        return { content: Buffer.from(content).toString("base64"), sha: "1" };
      },
    );
    const client = {
      getGitRef: vi.fn(async () => ({
        object: { sha: "base".padEnd(40, "0") },
      })),
      createGitRef: vi.fn(),
      createOrUpdateRepositoryFile,
      getRepositoryContent,
      decodeRepositoryContent: (c: { content: string }) =>
        Buffer.from(c.content, "base64").toString("utf8"),
    };
    const store = new GithubProvenanceEventStore({
      client: client as never,
      owner: "o",
      repo: "r",
      branch: "p-dev-runtime-state",
      autoCreateBranch: false,
    });
    const launchContext = ctx();
    const launchAttemptId = computeLaunchAttemptId(launchContext);
    const event = buildLaunchIntentEvent({
      launchAttemptId,
      launchContext,
      recordedAt: "2026-07-22T00:00:00.000Z",
    });
    const first = await store.persistImmutableEvent({
      event,
      commitMessage: `provenance: launch_intent ${launchAttemptId.slice(0, 12)}`,
    });
    expect(first.idempotent).toBe(false);
    const second = await store.persistImmutableEvent({
      event,
      commitMessage: `provenance: launch_intent ${launchAttemptId.slice(0, 12)}`,
    });
    expect(second.idempotent).toBe(true);

    await expect(
      store.persistImmutableEvent({
        event: { ...event, canonicalSemanticDigest: "0".repeat(64) },
        commitMessage: "provenance: divergent",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_event_divergence" });

    const path = provenanceEventRemotePath({
      launchAttemptId,
      eventType: "launch_intent",
    });
    expect(path).not.toContain("bc-");
    expect(createOrUpdateRepositoryFile).toHaveBeenCalled();
    expect(client.createGitRef).not.toHaveBeenCalled();
  });

  it("authorization failure surfaces as state unavailable", async () => {
    const store = new GithubProvenanceEventStore({
      client: {
        getGitRef: vi.fn(async () => {
          throw new GitHubApiError(401, "nope");
        }),
        createOrUpdateRepositoryFile: vi.fn(),
        getRepositoryContent: vi.fn(),
      } as never,
      owner: "o",
      repo: "r",
      autoCreateBranch: false,
    });
    const launchContext = ctx();
    const launchAttemptId = computeLaunchAttemptId(launchContext);
    const event = buildLaunchIntentEvent({
      launchAttemptId,
      launchContext,
      recordedAt: "2026-07-22T00:00:00.000Z",
    });
    await expect(
      store.persistImmutableEvent({
        event,
        commitMessage: "provenance: launch_intent x",
      }),
    ).rejects.toBeTruthy();
  });
});
