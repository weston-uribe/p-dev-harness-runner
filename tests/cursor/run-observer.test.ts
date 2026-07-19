import { describe, expect, it, vi } from "vitest";
import { CursorAgentError } from "@cursor/sdk";
import { sendAndObserve } from "../../src/cursor/run-observer.js";
import { EventLogger } from "../../src/artifacts/events.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImplementationError, PlanningError } from "../../src/runner/errors.js";

function createMockAgent(overrides: {
  send?: () => Promise<unknown>;
  stream?: () => AsyncIterable<{ type: string }>;
  wait?: () => Promise<unknown>;
  agentId?: string;
}) {
  return {
    agentId: overrides.agentId ?? "agent-1",
    send: overrides.send ?? vi.fn(),
    [Symbol.asyncDispose]: async () => undefined,
  };
}

describe("sendAndObserve", () => {
  it("classifies startup CursorAgentError as cursor_api_failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const agent = createMockAgent({
      send: vi.fn().mockRejectedValue(new CursorAgentError("auth failed")),
    });

    await expect(
      sendAndObserve(agent as never, "prompt", dir, events),
    ).rejects.toMatchObject({
      classification: "cursor_api_failure",
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("classifies failed run status as cursor_run_failed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const agent = createMockAgent({
      send: vi.fn().mockResolvedValue({
        id: "run-1",
        stream: async function* () {
          yield { type: "message" };
        },
        wait: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "error",
          durationMs: 100,
          error: { message: "run failed" },
        }),
      }),
    });

    await expect(
      sendAndObserve(agent as never, "prompt", dir, events),
    ).rejects.toBeInstanceOf(PlanningError);

    await rm(dir, { recursive: true, force: true });
  });

  it("returns assistant text on successful run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const agent = createMockAgent({
      send: vi.fn().mockResolvedValue({
        id: "run-2",
        stream: async function* () {
          yield { type: "message" };
        },
        wait: vi.fn().mockResolvedValue({
          id: "run-2",
          status: "completed",
          durationMs: 200,
          result: "## Implementation plan\n\nStep 1",
          git: { branches: [] },
        }),
      }),
    });

    const observed = await sendAndObserve(agent as never, "prompt", dir, events);
    expect(observed.assistantText).toContain("Implementation plan");
    expect(observed.runId).toBe("run-2");

    await rm(dir, { recursive: true, force: true });
  });

  it("passes per-send model, mode, and idempotencyKey to agent.send", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const send = vi.fn().mockResolvedValue({
      id: "run-idem",
      requestId: "req-1",
      stream: async function* () {
        yield { type: "message" };
      },
      wait: vi.fn().mockResolvedValue({
        id: "run-idem",
        status: "completed",
        durationMs: 100,
        result: "done",
        git: { branches: [] },
      }),
    });
    const agent = createMockAgent({ send });

    await sendAndObserve(agent as never, "prompt", dir, events, {
      model: { id: "composer-2.5" },
      mode: "agent",
      idempotencyKey: "p-dev:revision:WES-1:comment-1",
    });

    expect(send).toHaveBeenCalledWith("prompt", {
      model: { id: "composer-2.5" },
      mode: "agent",
      idempotencyKey: "p-dev:revision:WES-1:comment-1",
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("requires branch and PR for implementation runs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const agent = createMockAgent({
      send: vi.fn().mockResolvedValue({
        id: "run-3",
        stream: async function* () {
          yield { type: "message" };
        },
        wait: vi.fn().mockResolvedValue({
          id: "run-3",
          status: "finished",
          durationMs: 200,
          result: "## Implementation summary\n\nDone",
          git: {
            branches: [
              {
                repoUrl: "https://github.com/owner/example-target-app",
                branch: "cursor/wes-12-hello-world",
                prUrl:
                  "https://github.com/owner/example-target-app/pull/12",
              },
            ],
          },
        }),
      }),
    });

    const observed = await sendAndObserve(agent as never, "prompt", dir, events, {
      phase: "implementation",
      targetRepo: "https://github.com/owner/example-target-app",
    });

    expect(observed.gitResult?.branch).toBe("cursor/wes-12-hello-world");
    expect(observed.gitResult?.prUrl).toContain("/pull/12");

    await rm(dir, { recursive: true, force: true });
  });

  it("rejects implementation runs without PR metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const agent = createMockAgent({
      send: vi.fn().mockResolvedValue({
        id: "run-4",
        stream: async function* () {
          yield { type: "message" };
        },
        wait: vi.fn().mockResolvedValue({
          id: "run-4",
          status: "finished",
          durationMs: 200,
          result: "## Implementation summary\n\nDone",
          git: { branches: [] },
        }),
      }),
    });

    await expect(
      sendAndObserve(agent as never, "prompt", dir, events, {
        phase: "implementation",
        targetRepo: "https://github.com/owner/example-target-app",
      }),
    ).rejects.toBeInstanceOf(ImplementationError);

    await rm(dir, { recursive: true, force: true });
  });

  it("polls cloud run status when wait returns stream_unavailable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();

    const fetchCloudRun = vi
      .fn()
      .mockResolvedValueOnce({
        id: "run-6",
        status: "running",
      })
      .mockResolvedValueOnce({
        id: "run-6",
        status: "finished",
        durationMs: 5000,
        result: "## Implementation summary\n\nDone",
        git: {
          branches: [
            {
              repoUrl: "https://github.com/owner/example-target-app",
              branch: "cursor/wes-16-smoke",
              prUrl:
                "https://github.com/owner/example-target-app/pull/5",
            },
          ],
        },
      });

    const agent = createMockAgent({
      agentId: "bc-agent-1",
      send: vi.fn().mockResolvedValue({
        id: "run-6",
        stream: async function* () {
          yield { type: "message" };
        },
        wait: vi.fn().mockResolvedValue({
          id: "run-6",
          status: "error",
          durationMs: 100,
          error: {
            message: "Run stream is no longer available",
            code: "stream_unavailable",
          },
        }),
      }),
    });

    const observed = await sendAndObserve(agent as never, "prompt", dir, events, {
      phase: "implementation",
      targetRepo: "https://github.com/owner/example-target-app",
      apiKey: "cursor_test_key",
      pollIntervalMs: 1,
      fetchCloudRun,
    });

    expect(fetchCloudRun).toHaveBeenCalled();
    expect(observed.runId).toBe("run-6");
    expect(observed.gitResult?.prUrl).toContain("/pull/5");

    await rm(dir, { recursive: true, force: true });
  });

  it("cancels run when abort signal fires during streaming", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-observer-"));
    const events = new EventLogger(dir);
    await events.init();
    const logSpy = vi.spyOn(events, "log");

    const cancel = vi.fn().mockResolvedValue(undefined);
    const abortController = new AbortController();

    const agent = createMockAgent({
      send: vi.fn().mockResolvedValue({
        id: "run-5",
        supports: vi.fn().mockReturnValue(true),
        unsupportedReason: vi.fn(),
        cancel,
        stream: async function* () {
          abortController.abort(
            new ImplementationError(
              "cursor_run_timeout",
              "Cursor implementation run exceeded 60s",
            ),
          );
          yield { type: "message" };
          await new Promise(() => undefined);
        },
        wait: vi.fn(),
      }),
    });

    await expect(
      sendAndObserve(agent as never, "prompt", dir, events, {
        phase: "implementation",
        targetRepo: "https://github.com/owner/example-target-app",
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      classification: "cursor_run_timeout",
      cancelOutcome: "cancelled",
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "cursor_run_cancelled",
      "info",
      expect.objectContaining({ runId: "run-5" }),
    );

    await rm(dir, { recursive: true, force: true });
  });
});
