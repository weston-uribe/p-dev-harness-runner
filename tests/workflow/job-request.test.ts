import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import { jobRequestRemotePath } from "../../src/workflow/job-request/paths.js";
import { computeJobRequestDedupeIdentity } from "../../src/workflow/job-request/dedupe.js";
import {
  createJobRequest,
  buildJobRequestRecord,
} from "../../src/workflow/job-request/create.js";
import {
  claimJobRequest,
  completeJobRequest,
  JobRequestError,
} from "../../src/workflow/job-request/claim.js";
import { GithubJobRequestStore } from "../../src/workflow/job-request/store.js";

function createFakeGitHubClient() {
  const files = new Map<string, { sha: string; content: string }>();
  let shaCounter = 0;

  const client = {
    getGitRef: vi.fn(async () => ({
      ref: "refs/heads/p-dev-runtime-state",
      object: { sha: "branchsha" },
    })),
    getRepository: vi.fn(async () => ({ default_branch: "main" })),
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
      async (input: { path: string; content: string; sha?: string }) => {
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
      },
    ),
  };

  return { client, files };
}

describe("jobRequestRemotePath", () => {
  it("uses request id segment", () => {
    expect(jobRequestRemotePath("req-123")).toBe(
      ".p-dev/job-requests/req-123.json",
    );
  });
});

describe("computeJobRequestDedupeIdentity", () => {
  it("is stable for the same input", () => {
    const input = {
      issueKey: "TT-9",
      phase: "auto",
      triggerSource: "linear-webhook",
      linearDeliveryId: "delivery-1",
    };
    expect(computeJobRequestDedupeIdentity(input)).toBe(
      computeJobRequestDedupeIdentity(input),
    );
  });
});

describe("GithubJobRequestStore lifecycle", () => {
  it("creates, claims winner, conflicts on duplicate claim, completes", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });

    const created = await createJobRequest(store, {
      issueKey: "TT-9",
      phase: "auto",
      triggerSource: "linear-webhook",
      requestId: "opaque-req-1",
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    expect(created.state).toBe("pending");
    expect(created.revision).toBe(0);
    expect(created.requestId).toBe("opaque-req-1");

    const claimed = await claimJobRequest(store, {
      requestId: created.requestId,
      claimIdentity: "runner-a",
      now: new Date("2026-07-19T12:01:00.000Z"),
    });
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.record.state).toBe("claimed");
    expect(claimed.record.revision).toBe(1);

    await expect(
      claimJobRequest(store, {
        requestId: created.requestId,
        claimIdentity: "runner-b",
        now: new Date("2026-07-19T12:02:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "claim_conflict",
      message: expect.not.stringMatching(/TT-9/),
    });

    const completed = await completeJobRequest(store, {
      requestId: created.requestId,
      completionState: "verified_complete",
    });
    expect(completed.state).toBe("completed");
    expect(completed.completionState).toBe("verified_complete");
  });

  it("marks expired requests and rejects claim without leaking issue key", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });

    const record = buildJobRequestRecord({
      issueKey: "TT-7",
      phase: "planning",
      triggerSource: "linear-webhook",
      requestId: "opaque-req-expired",
      now: new Date("2026-07-19T12:00:00.000Z"),
      ttlMs: 60_000,
    });
    await store.create(record);

    await expect(
      claimJobRequest(store, {
        requestId: record.requestId,
        claimIdentity: "runner-a",
        now: new Date("2026-07-19T14:00:00.000Z"),
      }),
    ).rejects.toSatisfy((error: JobRequestError) => {
      expect(error).toBeInstanceOf(JobRequestError);
      expect(error.code).toBe("expired");
      expect(error.message).not.toMatch(/TT-7/);
      expect(error.message).not.toMatch(/planning/);
      return true;
    });
  });

  it("returns public-safe errors for missing and malformed records", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });

    await expect(
      claimJobRequest(store, {
        requestId: "missing-id",
        claimIdentity: "runner-a",
      }),
    ).rejects.toMatchObject({
      code: "missing",
      message: expect.not.stringMatching(/TT-/),
    });

    const badRecord = buildJobRequestRecord({
      issueKey: "TT-8",
      phase: "auto",
      triggerSource: "linear-webhook",
      requestId: "bad-req",
    });
    await store.create(badRecord);
    const path = jobRequestRemotePath("bad-req");
    const stored = await store.load("bad-req");
    expect(stored).not.toBeNull();
    await store.compareAndSet({
      requestId: "bad-req",
      expectedRevision: 0,
      next: {
        ...stored!,
        requestId: "different-id",
        revision: 1,
      },
    });

    await expect(
      claimJobRequest(store, {
        requestId: "bad-req",
        claimIdentity: "runner-a",
      }),
    ).rejects.toMatchObject({
      code: "malformed",
      message: expect.not.stringMatching(/TT-8/),
    });
  });
});
