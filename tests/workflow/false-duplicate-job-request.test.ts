import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../src/github/client.js";
import { jobRequestRemotePath } from "../../src/workflow/job-request/paths.js";
import {
  buildJobRequestRecord,
  createJobRequest,
} from "../../src/workflow/job-request/create.js";
import {
  claimJobRequest,
  completeJobRequest,
  reopenFalseDuplicateJobRequestForRetry,
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

describe("reopenFalseDuplicateJobRequestForRetry", () => {
  it("reopens completed duplicate_phase_completed envelopes for retry", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });

    const created = await createJobRequest(store, {
      issueKey: "FRE-7",
      phase: "code_review",
      triggerSource: "harness_code_review_handoff",
      requestId: "dup-false-1",
    });
    await claimJobRequest(store, {
      requestId: created.requestId,
      claimIdentity: "runner-a",
    });
    const completed = await completeJobRequest(store, {
      requestId: created.requestId,
      completionState: "duplicate_phase_completed",
    });
    expect(completed.state).toBe("completed");

    const reopened = await reopenFalseDuplicateJobRequestForRetry(store, {
      requestId: created.requestId,
      durableCompletionEvidenceAbsent: true,
    });
    expect(reopened?.state).toBe("pending");
    expect(reopened?.claimIdentity).toBeNull();
    expect(reopened?.completionState).toBeNull();
    expect(reopened?.dispatch?.confirmedAt).toBeNull();
    expect(reopened?.revision).toBe(completed.revision + 1);
  });

  it("refuses reopen when durable completion evidence is present", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });
    const record = buildJobRequestRecord({
      issueKey: "FRE-7",
      phase: "plan_review",
      triggerSource: "harness_plan_review_handoff",
      requestId: "dup-false-2",
    });
    await store.create(record);
    await claimJobRequest(store, {
      requestId: record.requestId,
      claimIdentity: "runner-b",
    });
    await completeJobRequest(store, {
      requestId: record.requestId,
      completionState: "duplicate_phase_completed",
    });

    const skipped = await reopenFalseDuplicateJobRequestForRetry(store, {
      requestId: record.requestId,
      durableCompletionEvidenceAbsent: false,
    });
    expect(skipped).toBeNull();
    expect((await store.load(record.requestId))?.state).toBe("completed");
  });

  it("does not reopen non-false-duplicate completion states", async () => {
    const { client } = createFakeGitHubClient();
    const store = new GithubJobRequestStore({
      client: client as never,
      owner: "state-owner",
      repo: "state-repo",
    });
    const created = await createJobRequest(store, {
      issueKey: "FRE-8",
      phase: "implementation",
      triggerSource: "harness_implementation_handoff",
      requestId: "dup-real-complete",
    });
    await claimJobRequest(store, {
      requestId: created.requestId,
      claimIdentity: "runner-c",
    });
    await completeJobRequest(store, {
      requestId: created.requestId,
      completionState: "verified_complete",
    });

    const reopened = await reopenFalseDuplicateJobRequestForRetry(store, {
      requestId: created.requestId,
      durableCompletionEvidenceAbsent: true,
    });
    expect(reopened).toBeNull();
    expect(jobRequestRemotePath(created.requestId)).toContain("dup-real-complete");
  });
});
