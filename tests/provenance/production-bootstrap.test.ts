import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  checkProvenanceStoreHealthReadOnly,
  createProductionProvenanceWriter,
} from "../../src/provenance/production-bootstrap.js";
import {
  createProductionLinearHarnessAgentProvider,
  getLinearHarnessAgentProvider,
  LinearHarnessAgentProvider,
  resetLinearHarnessAgentProviderForTests,
  setProductionBootstrapDepsForTests,
} from "../../src/agents/linear-harness-provider.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";
import { GitHubApiError } from "../../src/github/client.js";
import { createLinearHarnessLaunchContext } from "../../src/provenance/launch-context.js";
import { allocateProviderOperationId } from "../../src/provenance/provider-operation-id.js";
import type { AgentProvider } from "../../src/agents/types.js";

const KEY = "a".repeat(64);

function writingEnv(mode: "shadow" | "required"): Record<string, string> {
  return {
    P_DEV_CURSOR_PROVENANCE_MODE: mode,
    P_DEV_PROVENANCE_KEY_V1: KEY,
    P_DEV_WORKFLOW_STATE_REPOSITORY: "weston-uribe/p-dev-harness-state",
    P_DEV_WORKFLOW_STATE_BRANCH: "p-dev-runtime-state",
    P_DEV_STATE_GITHUB_TOKEN: "ghp_test_token_not_real",
  };
}

function sampleCtx() {
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

function stubInner(create: ReturnType<typeof vi.fn>): AgentProvider {
  return {
    id: "cursor",
    resolveModelId: () => "m",
    createPlanningAgent: create,
    createPlanReviewAgent: vi.fn(),
    createCodeReviewAgent: vi.fn(),
    createCodeRevisionAgent: vi.fn(),
    createImplementationAgent: vi.fn(),
    acquireBuilderAgent: vi.fn(),
    sendAndObserve: vi.fn(),
    disposeAgent: vi.fn(),
  } as unknown as AgentProvider;
}

describe("production provenance bootstrap", () => {
  beforeEach(() => {
    resetLinearHarnessAgentProviderForTests();
  });
  afterEach(() => {
    resetLinearHarnessAgentProviderForTests();
  });

  it("disabled default provider constructs no state client/store", async () => {
    setProductionBootstrapDepsForTests({
      env: { P_DEV_CURSOR_PROVENANCE_MODE: "disabled" },
      createGitHubClient: () => {
        throw new Error("must not construct client");
      },
    });
    const provider = getLinearHarnessAgentProvider();
    const health = await checkProvenanceStoreHealthReadOnly({
      env: { P_DEV_CURSOR_PROVENANCE_MODE: "disabled" },
      createGitHubClient: () => {
        throw new Error("must not construct client");
      },
    });
    expect(health.store).toBeNull();
    expect(health.successfullyInitialized).toBe(true);
    expect(provider.provenanceWriter.mode).toBe("disabled");
  });

  it("shadow default singleton constructs fake GitHub-backed store", async () => {
    const store = new InMemoryProvenanceEventStore();
    setProductionBootstrapDepsForTests({
      env: writingEnv("shadow"),
      storeOverride: store,
    });
    const provider = getLinearHarnessAgentProvider();
    expect(provider).toBeTruthy();
    const bundle = createProductionProvenanceWriter({
      env: writingEnv("shadow"),
      storeOverride: store,
    });
    const health = await bundle.ensureBootstrapped();
    expect(health.successfullyInitialized).toBe(true);
    expect(health.store).toBe(store);
    expect(bundle.getWriter().mode).toBe("shadow");
    const factoryProvider = createProductionLinearHarnessAgentProvider({
      env: writingEnv("shadow"),
      storeOverride: store,
    });
    expect(factoryProvider.provenanceWriter.mode).toBe("shadow");
  });

  it("required default singleton constructs fake store", async () => {
    const store = new InMemoryProvenanceEventStore();
    const bundle = createProductionProvenanceWriter({
      env: writingEnv("required"),
      storeOverride: store,
    });
    const health = await bundle.ensureBootstrapped();
    expect(health.successfullyInitialized).toBe(true);
    expect(health.coverageEligible).toBe(true);
    expect(bundle.getWriter().mode).toBe("required");
  });

  it("shadow bootstrap failure does not block provider mutation", async () => {
    const handle = { __brand: Symbol("h") };
    const innerCreate = vi.fn(async () => handle);
    vi.spyOn(
      await import("../../src/agents/cursor-provider.js"),
      "peekCursorAgentId",
    ).mockReturnValue("bc-agent-1");
    const bundle = createProductionProvenanceWriter({
      env: writingEnv("shadow"),
      storeOverride: null,
    });
    const p = new LinearHarnessAgentProvider({
      bootstrap: bundle,
      inner: stubInner(innerCreate) as never,
    });
    await p.createPlanningAgent({
      apiKey: "k",
      config: { orchestratorMarker: "x" } as never,
      targetRepo: "https://github.com/o/r",
      baseBranch: "main",
      launchContext: sampleCtx(),
    });
    expect(innerCreate).toHaveBeenCalled();
    const health = await bundle.ensureBootstrapped();
    expect(health.successfullyInitialized).toBe(false);
  });

  it("required bootstrap failure blocks before provider mutation", async () => {
    const innerCreate = vi.fn();
    const bundle = createProductionProvenanceWriter({
      env: writingEnv("required"),
      storeOverride: null,
    });
    const p = new LinearHarnessAgentProvider({
      bootstrap: bundle,
      inner: stubInner(innerCreate) as never,
    });
    await expect(
      p.createPlanningAgent({
        apiKey: "k",
        config: { orchestratorMarker: "x" } as never,
        targetRepo: "https://github.com/o/r",
        baseBranch: "main",
        launchContext: sampleCtx(),
      }),
    ).rejects.toMatchObject({ name: "CursorProvenanceError" });
    expect(innerCreate).not.toHaveBeenCalled();
  });

  it("missing branch is typed and not auto-created", async () => {
    const getGitRef = vi.fn(async () => {
      throw new GitHubApiError(404, "Not Found");
    });
    const createGitRef = vi.fn();
    const health = await checkProvenanceStoreHealthReadOnly({
      env: writingEnv("required"),
      githubClient: {
        getGitRef,
        createGitRef,
      } as never,
    });
    expect(health.failureCode).toBe(
      "cursor_provenance_bootstrap_branch_missing",
    );
    expect(createGitRef).not.toHaveBeenCalled();
    expect(health.owner).toBe("weston-uribe");
    expect(health.repo).toBe("p-dev-harness-state");
    expect(health.branch).toBe("p-dev-runtime-state");
  });

  it("zero-options singleton reset reconstructs across env cases", async () => {
    setProductionBootstrapDepsForTests({
      env: { P_DEV_CURSOR_PROVENANCE_MODE: "disabled" },
    });
    const a = getLinearHarnessAgentProvider();
    expect(a.provenanceWriter.mode).toBe("disabled");
    resetLinearHarnessAgentProviderForTests();
    const store = new InMemoryProvenanceEventStore();
    setProductionBootstrapDepsForTests({
      env: writingEnv("shadow"),
      storeOverride: store,
    });
    const b = getLinearHarnessAgentProvider();
    expect(b).not.toBe(a);
  });
});
