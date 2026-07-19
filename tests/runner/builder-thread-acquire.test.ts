import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentNotFoundError,
  AuthenticationError,
  NetworkError,
} from "@cursor/sdk";

const createMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const unarchiveMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cursor/sdk")>();
  return {
    ...actual,
    Agent: {
      ...actual.Agent,
      create: createMock,
      resume: resumeMock,
      get: getMock,
      unarchive: unarchiveMock,
    },
  };
});

import { acquireBuilderAgent } from "../../src/runner/builder-thread-acquire.js";
import { BuilderThreadLineageError } from "../../src/runner/builder-thread-lineage.js";
import type { HarnessConfig } from "../../src/config/types.js";

const TARGET_REPO = "https://github.com/owner/example-target-app";
const PR_URL = `${TARGET_REPO}/pull/1`;
const BRANCH = "cursor/wes-1";

function makeConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: [TARGET_REPO],
  } as HarnessConfig;
}

function makeEvents() {
  const entries: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    entries,
    log: vi.fn(async (event: string, _level: string, data?: Record<string, unknown>) => {
      entries.push({ event, data });
    }),
  };
}

function handoffComment(agentId = "bc-existing") {
  return `<!--\nharness-orchestrator-v1\nphase: handoff\nrun_id: handoff-1\nbuilder_agent_id: ${agentId}\nbuilder_thread_generation: 1\nbuilder_thread_action: created\nbuilder_origin_run_id: impl-1\ntarget_repo: ${TARGET_REPO}\npr_url: ${PR_URL}\nbranch: ${BRANCH}\n-->`;
}

describe("acquireBuilderAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({
      agentId: "bc-new",
      [Symbol.asyncDispose]: async () => undefined,
    });
    resumeMock.mockResolvedValue({
      agentId: "bc-existing",
      [Symbol.asyncDispose]: async () => undefined,
    });
    getMock.mockResolvedValue({ agentId: "bc-existing", archived: false });
    unarchiveMock.mockResolvedValue(undefined);
  });

  it("creates an initial implementation builder when no lineage exists", async () => {
    const events = makeEvents();
    const acquired = await acquireBuilderAgent({
      apiKey: "key",
      config: makeConfig(),
      phase: "implementation",
      events: events as never,
      context: {
        issueKey: "WES-1",
        harnessRunId: "run-1",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        branch: BRANCH,
        idempotencyKey: "p-dev:build:WES-1:branch",
        comments: [],
        orchestratorMarker: "harness-orchestrator-v1",
      },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0].cloud.autoCreatePR).toBe(true);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(acquired.continuity.action).toBe("created");
    expect(acquired.continuity.reference.agentId).toBe("bc-new");
  });

  it("resumes an existing builder for revision", async () => {
    const events = makeEvents();
    const acquired = await acquireBuilderAgent({
      apiKey: "key",
      config: makeConfig(),
      phase: "revision",
      events: events as never,
      context: {
        issueKey: "WES-1",
        harnessRunId: "run-2",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        branch: BRANCH,
        prUrl: PR_URL,
        idempotencyKey: "p-dev:revision:WES-1:fb-1",
        comments: [{ id: "c1", body: handoffComment() }],
        orchestratorMarker: "harness-orchestrator-v1",
      },
    });
    expect(resumeMock).toHaveBeenCalledWith("bc-existing", { apiKey: "key" });
    expect(createMock).not.toHaveBeenCalled();
    expect(acquired.continuity.action).toBe("resumed");
    expect(acquired.continuity.reference.agentId).toBe("bc-existing");
  });

  it("unarchives archived builders before resume", async () => {
    getMock.mockResolvedValue({ agentId: "bc-existing", archived: true });
    const events = makeEvents();
    await acquireBuilderAgent({
      apiKey: "key",
      config: makeConfig(),
      phase: "revision",
      events: events as never,
      context: {
        issueKey: "WES-1",
        harnessRunId: "run-2",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        branch: BRANCH,
        prUrl: PR_URL,
        idempotencyKey: "p-dev:revision:WES-1:fb-1",
        comments: [{ id: "c1", body: handoffComment() }],
        orchestratorMarker: "harness-orchestrator-v1",
      },
    });
    expect(unarchiveMock).toHaveBeenCalledWith("bc-existing", { apiKey: "key" });
    expect(events.entries.some((entry) => entry.event === "builder_thread_unarchived")).toBe(
      true,
    );
  });

  it("replaces on definitive agent loss using the existing PR branch factory", async () => {
    resumeMock.mockRejectedValue(new AgentNotFoundError("missing"));
    createMock.mockResolvedValue({
      agentId: "bc-replacement",
      [Symbol.asyncDispose]: async () => undefined,
    });
    const events = makeEvents();
    const acquired = await acquireBuilderAgent({
      apiKey: "key",
      config: makeConfig(),
      phase: "revision",
      events: events as never,
      context: {
        issueKey: "WES-1",
        harnessRunId: "run-3",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
        branch: BRANCH,
        prUrl: PR_URL,
        idempotencyKey: "p-dev:revision:WES-1:fb-2",
        comments: [{ id: "c1", body: handoffComment() }],
        orchestratorMarker: "harness-orchestrator-v1",
      },
    });
    expect(acquired.continuity.action).toBe("replaced");
    expect(acquired.continuity.reference.agentId).toBe("bc-replacement");
    expect(acquired.continuity.replacementReason).toBe("agent_not_found");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      cloud: {
        repos: [{ url: TARGET_REPO, startingRef: BRANCH, prUrl: PR_URL }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
  });

  it("does not replace on authentication failure", async () => {
    resumeMock.mockRejectedValue(new AuthenticationError("bad key"));
    await expect(
      acquireBuilderAgent({
        apiKey: "key",
        config: makeConfig(),
        phase: "revision",
        events: makeEvents() as never,
        context: {
          issueKey: "WES-1",
          harnessRunId: "run-4",
          targetRepo: TARGET_REPO,
          baseBranch: "main",
          branch: BRANCH,
          prUrl: PR_URL,
          idempotencyKey: "p-dev:revision:WES-1:fb-3",
          comments: [{ id: "c1", body: handoffComment() }],
          orchestratorMarker: "harness-orchestrator-v1",
        },
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(createMock).toHaveBeenCalledTimes(0);
  });

  it("does not replace on network failure", async () => {
    resumeMock.mockRejectedValue(new NetworkError("timeout"));
    await expect(
      acquireBuilderAgent({
        apiKey: "key",
        config: makeConfig(),
        phase: "revision",
        events: makeEvents() as never,
        context: {
          issueKey: "WES-1",
          harnessRunId: "run-5",
          targetRepo: TARGET_REPO,
          baseBranch: "main",
          branch: BRANCH,
          prUrl: PR_URL,
          idempotencyKey: "p-dev:revision:WES-1:fb-4",
          comments: [{ id: "c1", body: handoffComment() }],
          orchestratorMarker: "harness-orchestrator-v1",
        },
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws lineage integrity errors instead of legacy replacement", async () => {
    await expect(
      acquireBuilderAgent({
        apiKey: "key",
        config: makeConfig(),
        phase: "revision",
        events: makeEvents() as never,
        context: {
          issueKey: "WES-1",
          harnessRunId: "run-6",
          targetRepo: TARGET_REPO,
          baseBranch: "main",
          branch: BRANCH,
          prUrl: PR_URL,
          idempotencyKey: "p-dev:revision:WES-1:fb-5",
          comments: [
            { id: "c1", body: handoffComment("bc-a", 2) },
            { id: "c2", body: handoffComment("bc-b", 2) },
          ],
          orchestratorMarker: "harness-orchestrator-v1",
        },
      }),
    ).rejects.toBeInstanceOf(BuilderThreadLineageError);
    expect(createMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("refuses legacy_missing_lineage replacement without PR branch context", async () => {
    await expect(
      acquireBuilderAgent({
        apiKey: "key",
        config: makeConfig(),
        phase: "revision",
        events: makeEvents() as never,
        context: {
          issueKey: "WES-1",
          harnessRunId: "run-7",
          targetRepo: TARGET_REPO,
          baseBranch: "main",
          idempotencyKey: "p-dev:revision:WES-1:fb-6",
          comments: [],
          orchestratorMarker: "harness-orchestrator-v1",
        },
      }),
    ).rejects.toMatchObject({ reason: "missing_pr_lineage" });
    expect(createMock).not.toHaveBeenCalled();
  });
});
