import { describe, expect, it, vi } from "vitest";
import { sendAndObserve } from "../../src/cursor/run-observer.js";
import type { EventLogger } from "../../src/artifacts/events.js";
import type { SDKAgent, Run, RunResult } from "@cursor/sdk";

describe("run-observer provenance hooks", () => {
  it("invokes onRunAcknowledged before onAgentCreated and onRunTerminal before classification throw", async () => {
    const order: string[] = [];
    const runResult: RunResult = {
      id: "run-1",
      status: "error",
      durationMs: 1,
      model: null,
      git: null,
      error: { code: "x", message: "failed" },
      usage: null,
      result: null,
      requestId: null,
    } as unknown as RunResult;

    const run = {
      id: "run-1",
      async *stream() {
        // empty
      },
      wait: vi.fn(async () => runResult),
    } as unknown as Run;

    const agent = {
      agentId: "bc-hook-agent",
      send: vi.fn(async () => {
        order.push("send");
        return run;
      }),
    } as unknown as SDKAgent;

    const events = {
      log: vi.fn(async () => undefined),
    } as unknown as EventLogger;

    await expect(
      sendAndObserve(agent, "prompt", "/tmp/run-obs-hooks", events, {
        phase: "planning",
        onBeforeSend: async () => {
          order.push("before_send");
        },
        onRunAcknowledged: async () => {
          order.push("run_ack");
        },
        onAgentCreated: async () => {
          order.push("agent_created");
        },
        onRunTerminal: async () => {
          order.push("run_terminal");
        },
      }),
    ).rejects.toThrow(/status error|failed/i);

    expect(order).toEqual([
      "before_send",
      "send",
      "run_ack",
      "agent_created",
      "run_terminal",
    ]);
  });
});
