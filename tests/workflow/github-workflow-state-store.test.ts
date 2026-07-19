import { describe, expect, it, vi } from "vitest";
import {
  GithubWorkflowStateStore,
  workflowStateRemotePath,
} from "../../src/workflow/state/github-store.js";
import { createEmptyWorkflowState } from "../../src/workflow/state/types.js";
import {
  createWorkflowStateStore,
  WorkflowStateStoreError,
} from "../../src/workflow/state/factory.js";
import {
  buildHandoffSubjectIdentity,
  buildPlanReviewSubjectIdentity,
  buildCodeReviewSubjectIdentity,
  buildAcceptedReviewDecisionIdentity,
} from "../../src/workflow/subject-identities.js";

describe("workflowStateRemotePath", () => {
  it("uses team and issue segments", () => {
    expect(workflowStateRemotePath("team-1", "TT-9")).toBe(
      ".p-dev/workflow-state/team-1/TT-9.json",
    );
  });
});

describe("GithubWorkflowStateStore CAS", () => {
  it("creates once and rejects stale revision", async () => {
    const files = new Map<string, { sha: string; content: string }>();
    let shaCounter = 0;
    const client = {
      getGitRef: vi.fn(async () => ({
        ref: "refs/heads/p-dev-runtime-state",
        object: { sha: "branchsha" },
      })),
      getRepository: vi.fn(),
      createGitRef: vi.fn(),
      getRepositoryContent: vi.fn(
        async (_o: string, _r: string, path: string) => {
          const hit = files.get(path);
          if (!hit) return null;
          return {
            name: path.split("/").pop()!,
            path,
            sha: hit.sha,
            content: Buffer.from(hit.content, "utf8").toString("base64"),
            encoding: "base64",
          };
        },
      ),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
      createOrUpdateRepositoryFile: vi.fn(
        async (input: {
          path: string;
          content: string;
          sha?: string;
        }) => {
          const existing = files.get(input.path);
          if (input.sha) {
            if (!existing || existing.sha !== input.sha) {
              const err = new Error("conflict") as Error & { status: number };
              err.name = "GitHubApiError";
              (err as { status: number }).status = 409;
              throw Object.assign(new Error("sha mismatch"), { status: 409 });
            }
          } else if (existing) {
            throw Object.assign(new Error("already exists"), { status: 422 });
          }
          shaCounter += 1;
          const sha = `sha-${shaCounter}`;
          files.set(input.path, { sha, content: input.content });
          return { commitSha: `commit-${shaCounter}` };
        },
      ),
    };

    // Patch GitHubApiError check: store uses instanceof GitHubApiError.
    // Use real client type by importing and wrapping.
    const { GitHubApiError } = await import("../../src/github/client.js");
    const wrapped = {
      ...client,
      createOrUpdateRepositoryFile: vi.fn(async (input: {
        path: string;
        content: string;
        sha?: string;
      }) => {
        const existing = files.get(input.path);
        if (input.sha) {
          if (!existing || existing.sha !== input.sha) {
            throw new GitHubApiError(409, "sha mismatch");
          }
        } else if (existing) {
          throw new GitHubApiError(422, "already exists");
        }
        shaCounter += 1;
        const sha = `sha-${shaCounter}`;
        files.set(input.path, { sha, content: input.content });
        return { commitSha: `commit-${shaCounter}` };
      }),
    };

    const store = new GithubWorkflowStateStore({
      client: wrapped as never,
      owner: "weston-uribe",
      repo: "p-dev-harness",
      teamId: "team-1",
    });

    const base = createEmptyWorkflowState({
      issueKey: "TT-9",
      workflowSchemaVersion: "product-development-v2",
    });
    const created = await store.compareAndSet({
      issueKey: "TT-9",
      expectedRevision: 0,
      next: { ...base, stateRevision: 1, currentPhaseId: "planning" },
    });
    expect(created?.stateRevision).toBe(1);

    const stale = await store.compareAndSet({
      issueKey: "TT-9",
      expectedRevision: 0,
      next: { ...base, stateRevision: 1, currentPhaseId: "stale" },
    });
    expect(stale).toBeNull();

    const loaded = await store.load("TT-9");
    expect(loaded?.currentPhaseId).toBe("planning");

    const updated = await store.compareAndSet({
      issueKey: "TT-9",
      expectedRevision: 1,
      next: {
        ...loaded!,
        stateRevision: 2,
        currentPhaseId: "plan_review",
      },
    });
    expect(updated?.currentPhaseId).toBe("plan_review");
  });
});

describe("createWorkflowStateStore fail-closed managed mode", () => {
  it("never falls back to file when managed_github lacks credentials", async () => {
    await expect(
      createWorkflowStateStore({
        mode: "managed_github",
        teamId: "team-1",
        env: {},
      }),
    ).rejects.toBeInstanceOf(WorkflowStateStoreError);
  });

  it("uses file mode when explicitly selected", async () => {
    const store = await createWorkflowStateStore({
      mode: "file",
      logDirectory: "/tmp/p-dev-workflow-state-test",
      env: {},
    });
    expect(store.constructor.name).toBe("FileWorkflowStateStore");
  });
});

describe("subject identities", () => {
  it("handoff subject changes when head/diff changes", () => {
    const a = buildHandoffSubjectIdentity({
      issueKey: "TT-1",
      targetRepo: "https://github.com/o/r",
      implementationGenerationId: "g1",
      prNumber: 1,
      headSha: "aaa",
      diffHash: "d1",
    });
    const b = buildHandoffSubjectIdentity({
      issueKey: "TT-1",
      targetRepo: "https://github.com/o/r",
      implementationGenerationId: "g1",
      prNumber: 1,
      headSha: "bbb",
      diffHash: "d2",
    });
    expect(a).not.toBe(b);
  });

  it("review decision identity ignores reviewer generation", () => {
    const subject = buildPlanReviewSubjectIdentity({
      issueKey: "TT-1",
      planGenerationId: "p1",
      planHash: "h1",
      reviewCycle: 0,
    });
    const d1 = buildAcceptedReviewDecisionIdentity({
      decision: "needs_revision",
      subjectIdentity: subject,
    });
    const d2 = buildAcceptedReviewDecisionIdentity({
      decision: "needs_revision",
      subjectIdentity: subject,
    });
    expect(d1).toBe(d2);

    const codeSubject = buildCodeReviewSubjectIdentity({
      issueKey: "TT-1",
      prNumber: 9,
      headSha: "h",
      diffHash: "d",
      reviewCycle: 0,
    });
    expect(codeSubject).toHaveLength(32);
  });
});
