import { describe, expect, it, vi } from "vitest";
import { buildCoverageGapRecord } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { CursorProvenanceError } from "../../src/provenance/errors.js";
import {
  GithubProvenanceLifecycleStore,
  InMemoryProvenanceLifecycleStore,
} from "../../src/provenance/lifecycle-store.js";

function base64Content(body: string) {
  return { content: Buffer.from(body, "utf8").toString("base64") };
}

describe("LifecycleWritePolicy verify_existing_only", () => {
  it("Github store: identical existing adopts without writes", async () => {
    const record = buildCoverageGapRecord({
      epochId: "epoch-test",
      intervalAttempted: {
        coverageStart: "2026-07-20T00:00:00.000Z",
        coverageEnd: "2026-07-20T01:00:00.000Z",
      },
      incompleteReasons: ["coverage_event_snapshot_missing"] as any,
      evidenceDigest: "e".repeat(64),
    });
    const body = `${JSON.stringify(record, null, 2)}\n`;

    const client = {
      getGitRef: vi.fn(async () => ({ object: { sha: "tip" } })),
      getRepositoryContent: vi.fn(async () => base64Content(body)),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
      createOrUpdateRepositoryFile: vi.fn(),
      createGitRef: vi.fn(),
      getRepository: vi.fn(),
      listCommits: vi.fn(),
    } as any;

    const store = new GithubProvenanceLifecycleStore({
      client,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: "main",
      autoCreateBranch: true,
      writePolicy: "verify_existing_only",
    });

    const result = await store.persistImmutableRecord({
      path: ".p-dev/test/gap.json",
      body,
      canonicalDigest: record.gapDigest,
      commitMessage: "no-op",
    });

    expect(result.idempotent).toBe(true);
    expect(result.commitSha).toBeNull();
    expect(store.writeAttemptCount).toBe(1);
    expect(client.createOrUpdateRepositoryFile).not.toHaveBeenCalled();
    expect(client.createGitRef).not.toHaveBeenCalled();
  });

  it("Github store: missing path throws read_only_violation without writes", async () => {
    const client = {
      getGitRef: vi.fn(async () => ({ object: { sha: "tip" } })),
      getRepositoryContent: vi.fn(async () => null),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
      createOrUpdateRepositoryFile: vi.fn(),
      createGitRef: vi.fn(),
      getRepository: vi.fn(),
      listCommits: vi.fn(),
    } as any;

    const store = new GithubProvenanceLifecycleStore({
      client,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: "main",
      writePolicy: "verify_existing_only",
    });

    await expect(
      store.persistImmutableRecord({
        path: ".p-dev/test/missing.json",
        body: "{}\n",
        canonicalDigest: "d".repeat(64),
        commitMessage: "no-op",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_read_only_violation" });

    expect(client.createOrUpdateRepositoryFile).not.toHaveBeenCalled();
  });

  it("Github store: divergent existing throws event_divergence", async () => {
    const record = buildCoverageGapRecord({
      epochId: "epoch-test",
      intervalAttempted: {
        coverageStart: "2026-07-20T00:00:00.000Z",
        coverageEnd: "2026-07-20T01:00:00.000Z",
      },
      incompleteReasons: ["coverage_event_snapshot_missing"] as any,
      evidenceDigest: "e".repeat(64),
    });
    const body = `${JSON.stringify(record, null, 2)}\n`;

    const client = {
      getGitRef: vi.fn(async () => ({ object: { sha: "tip" } })),
      getRepositoryContent: vi.fn(async () => base64Content(body)),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
      createOrUpdateRepositoryFile: vi.fn(),
      createGitRef: vi.fn(),
      getRepository: vi.fn(),
      listCommits: vi.fn(),
    } as any;

    const store = new GithubProvenanceLifecycleStore({
      client,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: "main",
      writePolicy: "verify_existing_only",
    });

    await expect(
      store.persistImmutableRecord({
        path: ".p-dev/test/gap.json",
        body,
        canonicalDigest: "d".repeat(64),
        commitMessage: "no-op",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_event_divergence" });
    expect(client.createOrUpdateRepositoryFile).not.toHaveBeenCalled();
  });

  it("Github store: integrity failure throws coverage_integrity_error", async () => {
    const client = {
      getGitRef: vi.fn(async () => ({ object: { sha: "tip" } })),
      getRepositoryContent: vi.fn(async () => base64Content("{\n")),
      decodeRepositoryContent: (content: { content: string }) =>
        Buffer.from(content.content, "base64").toString("utf8"),
      createOrUpdateRepositoryFile: vi.fn(),
      createGitRef: vi.fn(),
      getRepository: vi.fn(),
      listCommits: vi.fn(),
    } as any;

    const store = new GithubProvenanceLifecycleStore({
      client,
      owner: "weston-uribe",
      repo: "p-dev-harness-state",
      branch: "main",
      writePolicy: "verify_existing_only",
    });

    await expect(
      store.persistImmutableRecord({
        path: ".p-dev/test/bad.json",
        body: "{}\n",
        canonicalDigest: "d".repeat(64),
        commitMessage: "no-op",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_coverage_integrity_error" });
    expect(client.createOrUpdateRepositoryFile).not.toHaveBeenCalled();
  });

  it("InMemory store: missing path throws read_only_violation", async () => {
    const store = new InMemoryProvenanceLifecycleStore({
      writePolicy: "verify_existing_only",
    });
    await expect(
      store.persistImmutableRecord({
        path: ".p-dev/test/missing.json",
        body: "{}\n",
        canonicalDigest: "d".repeat(64),
        commitMessage: "no-op",
      }),
    ).rejects.toBeInstanceOf(CursorProvenanceError);
    await expect(
      store.persistImmutableRecord({
        path: ".p-dev/test/missing.json",
        body: "{}\n",
        canonicalDigest: "d".repeat(64),
        commitMessage: "no-op",
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_read_only_violation" });
  });
});

