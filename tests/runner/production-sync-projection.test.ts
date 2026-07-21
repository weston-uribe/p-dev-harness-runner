import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transitionIssueStatus: vi.fn(),
  postProductionSyncComment: vi.fn(),
  listIssueComments: vi.fn(),
  createLinearClient: vi.fn(),
  fetchLinearIssue: vi.fn(),
  listTeamWorkflowStates: vi.fn(),
  resolvePromotionProof: vi.fn(),
  verifyVercelProductionDeployment: vi.fn(),
  createEvaluationRuntime: vi.fn(),
  recordAcknowledgedScore: vi.fn(),
}));

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(() => ({})),
  listTeamWorkflowStates: mocks.listTeamWorkflowStates,
}));

vi.mock("../../src/linear/writer.js", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  postProductionSyncComment: mocks.postProductionSyncComment,
  listIssueComments: mocks.listIssueComments,
  createLinearClient: mocks.createLinearClient,
  postPlanningComment: vi.fn(),
  postErrorComment: vi.fn(),
}));

vi.mock("../../src/linear/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/linear/client.js")>();
  return {
    ...actual,
    fetchLinearIssue: mocks.fetchLinearIssue,
  };
});

vi.mock("../../src/github/commit-reachability.js", () => ({
  resolvePromotionProof: mocks.resolvePromotionProof,
}));

vi.mock("../../src/preview/production-deployment-verify.js", () => ({
  verifyVercelProductionDeployment: mocks.verifyVercelProductionDeployment,
}));

vi.mock("../../src/evaluation/runtime.js", () => ({
  createEvaluationRuntime: mocks.createEvaluationRuntime,
  createNoopRuntime: vi.fn(),
  resolveEvaluationConfig: vi.fn(),
  setLangfuseRuntimeFactoryForTests: vi.fn(),
}));

vi.mock("../../src/github/client.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({})),
}));

import { executeProductionSyncForIssue } from "../../src/runner/phases/production-sync.js";
import {
  buildProductionCompletionId,
  buildProductionEffectId,
  createProductionCompletionRecord,
  isProductionEffectCompleted,
  upsertProductionEffect,
  withProductionState,
} from "../../src/workflow/state/production-completion.js";
import {
  createEmptyWorkflowState,
  FileWorkflowStateStore,
} from "../../src/workflow/state/index.js";
import { WORKFLOW_SCHEMA_VERSION } from "../../src/workflow/definition/product-development.v2.js";
import type { HarnessConfig } from "../../src/config/types.js";

const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROD_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET = "https://github.com/owner/example-target-app";

const VALID_WORKFLOW_STATES = [
  { id: "s-backlog", name: "Backlog", type: "backlog" },
  { id: "s-mtd", name: "Merged to Dev", type: "completed" },
  { id: "s-deployed", name: "Merged / Deployed", type: "completed" },
  { id: "s-canceled", name: "Canceled", type: "canceled" },
];

const ISSUE_DESCRIPTION = `## Target repo

owner/example-target-app

## Task

Ship

## Acceptance criteria

- [ ] Done

## Out of scope

- None`;

function mergeCommentBody(): string {
  return `Merged.

---
harness-orchestrator-v1
phase: merge
run_id: merge-1
model: composer-2.5
prompt_version: 1
target_repo: ${TARGET}
issue_key: WES-SYNC
base_branch: dev
production_branch: main
merge_commit_sha: ${MERGE_SHA}
pr_url: https://github.com/owner/example-target-app/pull/1
pr_number: 1
branch: cursor/wes-sync
---
`;
}

function productionCommentBody(input?: {
  productionCompletionId?: string;
  productionEffectId?: string;
}): string {
  const completionId =
    input?.productionCompletionId ??
    buildProductionCompletionId({
      issueKey: "WES-SYNC",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
  const effectId =
    input?.productionEffectId ??
    buildProductionEffectId(completionId, "linear_production_comment");
  return `Promoted.

---
harness-orchestrator-v1
phase: production_sync
run_id: sync-1
model: 
prompt_version: 1
target_repo: ${TARGET}
issue_key: WES-SYNC
base_branch: dev
production_branch: main
merge_commit_sha: ${MERGE_SHA}
production_head_sha: ${PROD_HEAD}
production_completion_id: ${completionId}
production_effect_id: ${effectId}
---
`;
}

function buildConfig(tempRoot: string): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: tempRoot,
    defaultModel: { id: "composer-2.5" },
    linear: {
      teamKey: "WES",
      teamId: "team-configured",
      transitionalStatuses: {
        mergedToDev: "Merged to Dev",
        mergedDeployed: "Merged / Deployed",
      },
    },
    repos: [
      {
        id: "target-app",
        linearProjects: ["Example Target App"],
        targetRepo: TARGET,
        baseBranch: "dev",
        productionBranch: "main",
        previewProvider: "vercel",
        integrationSuccessStatus: "Merged to Dev",
        productionSuccessStatus: "Merged / Deployed",
      },
    ],
    allowedTargetRepos: [TARGET],
  };
}

function evaluationRuntime() {
  return {
    enabled: true,
    namespace: "test",
    async startPhaseTrace() {
      return {
        correlation: {
          sessionId: "sess",
          traceId: "trace-1",
          namespace: "test",
        },
        startChild: () => ({
          update: () => {},
          end: () => {},
          startChild: () => ({
            update: () => {},
            end: () => {},
            startChild: () => {
              throw new Error("unused");
            },
          }),
        }),
        finish: () => {},
      };
    },
    recordScore: vi.fn(),
    recordAcknowledgedScore: mocks.recordAcknowledgedScore,
    async flushAndShutdown() {},
  };
}

describe("production-sync crash-safe projection", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(path.join(tmpdir(), "prod-sync-proj-"));
    configPath = path.join(tempRoot, "harness.config.json");
    await writeFile(configPath, JSON.stringify(buildConfig(tempRoot)), "utf8");

    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_TOKEN = "ghp_testtoken";
    process.env.VERCEL_TOKEN = "vercel-test";
    delete process.env.P_DEV_WORKFLOW_STATE_STORE_MODE;

    mocks.listTeamWorkflowStates.mockResolvedValue(VALID_WORKFLOW_STATES);
    mocks.createLinearClient.mockReturnValue({});
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
    ]);
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-sync",
      identifier: "WES-SYNC",
      title: "Sync",
      description: ISSUE_DESCRIPTION,
      status: "Merged to Dev",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: "WES",
      teamId: "team-configured",
      url: null,
    });
    mocks.resolvePromotionProof.mockResolvedValue({
      proof: true,
      mergeCommitSha: MERGE_SHA,
      productionHeadSha: PROD_HEAD,
      method: "merge_commit_ancestry",
    });
    mocks.verifyVercelProductionDeployment.mockResolvedValue({
      verified: true,
      provider: "vercel",
      deploymentId: "dpl_1",
      deploymentSha: PROD_HEAD,
      aliasSha: PROD_HEAD,
      deploymentUrl: "https://example.vercel.app",
    });
    mocks.postProductionSyncComment.mockResolvedValue({ id: "c-prod" });
    mocks.transitionIssueStatus.mockResolvedValue(undefined);
    mocks.recordAcknowledgedScore.mockResolvedValue(undefined);
    mocks.createEvaluationRuntime.mockResolvedValue(evaluationRuntime());
  });

  afterEach(async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.VERCEL_TOKEN;
    delete process.env.P_DEV_WORKFLOW_STATE_STORE_MODE;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("comment succeeds then status fails; retry adopts comment and completes", async () => {
    mocks.transitionIssueStatus
      .mockRejectedValueOnce(new Error("status write failed"))
      .mockResolvedValueOnce(undefined);

    const first = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(first.manifest.finalOutcome).toBe("failed");
    expect(first.manifest.errorClassification).toBe(
      "linear_status_transition_failure",
    );
    expect(mocks.postProductionSyncComment).toHaveBeenCalledTimes(1);

    const store = new FileWorkflowStateStore(tempRoot);
    const afterFirst = await store.load("WES-SYNC");
    expect(
      isProductionEffectCompleted(
        afterFirst!.productionCompletion!,
        "linear_production_comment",
      ),
    ).toBe(true);
    expect(
      isProductionEffectCompleted(
        afterFirst!.productionCompletion!,
        "linear_status_transition",
      ),
    ).toBe(false);

    // Simulate Linear now having the posted comment for adoption on retry
    const postedBody = mocks.postProductionSyncComment.mock.calls[0]?.[2]
      ? // body is arg index 2 in postProductionSyncComment(client, issueId, body, footer)
        undefined
      : undefined;
    void postedBody;
    const footer = mocks.postProductionSyncComment.mock.calls[0]?.[3] as {
      productionCompletionId: string;
      productionEffectId: string;
    };
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
      {
        id: "c-prod",
        body: productionCommentBody({
          productionCompletionId: footer.productionCompletionId,
          productionEffectId: footer.productionEffectId,
        }),
      },
    ]);

    const second = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(second.manifest.finalOutcome).toBe("success");
    expect(mocks.postProductionSyncComment).toHaveBeenCalledTimes(1);
    expect(mocks.transitionIssueStatus).toHaveBeenCalledTimes(2);
    const afterSecond = await store.load("WES-SYNC");
    expect(afterSecond!.productionCompletion!.state).toBe("completed");
  });

  it("adopts existing comment when durable comment effect is missing", async () => {
    const completionId = buildProductionCompletionId({
      issueKey: "WES-SYNC",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
      {
        id: "c-prod",
        body: productionCommentBody({ productionCompletionId: completionId }),
      },
    ]);

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).toHaveBeenCalledTimes(1);
  });

  it("adopts status when Linear is already production-success", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-sync",
      identifier: "WES-SYNC",
      title: "Sync",
      description: ISSUE_DESCRIPTION,
      status: "Merged / Deployed",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: "WES",
      teamId: "team-configured",
      url: null,
    });
    const completionId = buildProductionCompletionId({
      issueKey: "WES-SYNC",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
      {
        id: "c-prod",
        body: productionCommentBody({ productionCompletionId: completionId }),
      },
    ]);

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
  });

  it("does not adopt unrelated historical production comment", async () => {
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
      {
        id: "c-other",
        body: productionCommentBody({
          productionCompletionId: "deadbeef".repeat(8),
          productionEffectId: "cafebabe".repeat(8),
        }).replace(MERGE_SHA, "ffffffffffffffffffffffffffffffffffffffff"),
      },
    ]);

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("success");
    expect(mocks.postProductionSyncComment).toHaveBeenCalledTimes(1);
  });

  it("fully completed second reconcile is a true no-op", async () => {
    const first = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(first.manifest.finalOutcome).toBe("success");
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-sync",
      identifier: "WES-SYNC",
      title: "Sync",
      description: ISSUE_DESCRIPTION,
      status: "Merged / Deployed",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: "WES",
      teamId: "team-configured",
      url: null,
    });
    const store = new FileWorkflowStateStore(tempRoot);
    const before = await store.load("WES-SYNC");
    const revision = before!.stateRevision;

    const second = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(second.manifest.finalOutcome).toBe("duplicate");
    const after = await store.load("WES-SYNC");
    expect(after!.stateRevision).toBe(revision);
    expect(mocks.postProductionSyncComment).toHaveBeenCalledTimes(1);
    expect(mocks.transitionIssueStatus).toHaveBeenCalledTimes(1);
  });

  it("fails unexpected status with wrong_status and zero writes", async () => {
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-sync",
      identifier: "WES-SYNC",
      title: "Sync",
      description: ISSUE_DESCRIPTION,
      status: "Backlog",
      projectName: "Example Target App",
      teamName: "WES",
      teamKey: "WES",
      teamId: "team-configured",
      url: null,
    });

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe("wrong_status");
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
    expect(mocks.recordAcknowledgedScore).not.toHaveBeenCalled();
  });

  it("managed state failure fails closed before Linear/Langfuse writes", async () => {
    process.env.P_DEV_WORKFLOW_STATE_STORE_MODE = "managed_github";
    delete process.env.P_DEV_STATE_GITHUB_TOKEN;
    delete process.env.P_DEV_WORKFLOW_STATE_REPOSITORY;

    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe(
      "durable_state_unavailable",
    );
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
    expect(mocks.transitionIssueStatus).not.toHaveBeenCalled();
    expect(mocks.recordAcknowledgedScore).not.toHaveBeenCalled();
  });

  it("langfuse create failure surfaces langfuse_projection_failure", async () => {
    mocks.recordAcknowledgedScore.mockRejectedValueOnce(
      new Error("langfuse_projection_failure: score create failed"),
    );
    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("failed");
    expect(result.manifest.errorClassification).toBe(
      "langfuse_projection_failure",
    );
    expect(mocks.postProductionSyncComment).not.toHaveBeenCalled();
  });

  it("marker alone does not whole-phase skip while status is integration-success", async () => {
    const completionId = buildProductionCompletionId({
      issueKey: "WES-SYNC",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
    mocks.listIssueComments.mockResolvedValue([
      { id: "c-merge", body: mergeCommentBody() },
      {
        id: "c-prod",
        body: productionCommentBody({ productionCompletionId: completionId }),
      },
    ]);
    // No durable state — must continue and complete remaining effects
    const result = await executeProductionSyncForIssue({
      issueKey: "WES-SYNC",
      configPath,
    });
    expect(result.manifest.finalOutcome).toBe("success");
    expect(result.manifest.errorClassification).not.toBe(
      "duplicate_phase_completed",
    );
  });
});

describe("production-completion CAS mutation", () => {
  it("preserves unrelated outer fields and completed sibling effects on conflict", async () => {
    const {
      mutateProductionCompletionCas,
      InMemoryWorkflowStateStore,
    } = await import("../../src/workflow/state/index.js");

    const store = new InMemoryWorkflowStateStore();
    let base = createEmptyWorkflowState({
      issueKey: "WES-CAS",
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
    });
    base = {
      ...base,
      builderAgentId: "builder-keep",
      sideEffects: [
        {
          identity: "se-1",
          kind: "manifest_telemetry",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    let completion = createProductionCompletionRecord({
      issueKey: "WES-CAS",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
    completion = upsertProductionEffect(
      completion,
      "linear_production_comment",
      "completed",
    );
    base = {
      ...base,
      productionCompletion: completion,
      stateRevision: 0,
    };
    await store.compareAndSet({
      issueKey: "WES-CAS",
      expectedRevision: 0,
      next: { ...base, stateRevision: 1 },
    });

    let conflictInjected = false;
    const originalCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (input) => {
      if (!conflictInjected) {
        conflictInjected = true;
        const latest = (await store.load("WES-CAS"))!;
        await originalCas({
          issueKey: "WES-CAS",
          expectedRevision: latest.stateRevision,
          next: {
            ...latest,
            stateRevision: latest.stateRevision + 1,
            planReviewerAgentId: "reviewer-concurrent",
            productionCompletion: upsertProductionEffect(
              latest.productionCompletion!,
              "langfuse_promoted_to_main",
              "completed",
            ),
          },
        });
        return null;
      }
      return originalCas(input);
    };

    const saved = await mutateProductionCompletionCas({
      store,
      issueKey: "WES-CAS",
      productionCompletionId: completion.productionCompletionId,
      seedIfMissing: () => completion,
      mutate: (latest) =>
        upsertProductionEffect(latest, "linear_status_transition", "completed"),
    });

    expect(saved.builderAgentId).toBe("builder-keep");
    expect(saved.planReviewerAgentId).toBe("reviewer-concurrent");
    expect(saved.sideEffects?.[0]?.identity).toBe("se-1");
    expect(
      isProductionEffectCompleted(
        saved.productionCompletion!,
        "linear_production_comment",
      ),
    ).toBe(true);
    expect(
      isProductionEffectCompleted(
        saved.productionCompletion!,
        "langfuse_promoted_to_main",
      ),
    ).toBe(true);
    expect(
      isProductionEffectCompleted(
        saved.productionCompletion!,
        "linear_status_transition",
      ),
    ).toBe(true);
  });

  it("throws durable_state_cas_exhausted after bounded retries", async () => {
    const {
      mutateProductionCompletionCas,
      DurableStateCasExhaustedError,
      InMemoryWorkflowStateStore,
    } = await import("../../src/workflow/state/index.js");

    const store = new InMemoryWorkflowStateStore();
    const empty = createEmptyWorkflowState({
      issueKey: "WES-EXH",
      workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
    });
    const completion = createProductionCompletionRecord({
      issueKey: "WES-EXH",
      targetRepository: TARGET,
      mergeToDevSha: MERGE_SHA,
      productionBranch: "main",
    });
    await store.compareAndSet({
      issueKey: "WES-EXH",
      expectedRevision: 0,
      next: {
        ...empty,
        stateRevision: 1,
        productionCompletion: completion,
      },
    });
    store.compareAndSet = async () => null;

    await expect(
      mutateProductionCompletionCas({
        store,
        issueKey: "WES-EXH",
        productionCompletionId: completion.productionCompletionId,
        seedIfMissing: () => completion,
        mutate: (latest) => withProductionState(latest, "completed"),
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(DurableStateCasExhaustedError);
  });
});
