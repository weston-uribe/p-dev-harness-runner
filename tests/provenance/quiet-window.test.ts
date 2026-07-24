import { describe, expect, it, vi } from "vitest";
import {
  inspectQuietWindow,
  waitAndInspectQuietWindow,
} from "../../src/provenance/quiet-window.js";

function mockClient(input: {
  runsByWorkflow: Record<string, Array<{ id: number; status: string; event?: string; name?: string }>>;
  tipSha?: string;
}) {
  return {
    listWorkflowRuns: vi.fn(
      async (_owner: string, _repo: string, workflowFile: string) =>
        (input.runsByWorkflow[workflowFile] ?? []).map((run) => ({
          id: run.id,
          status: run.status as "queued",
          conclusion: null,
          html_url: `https://github.com/example/run/${run.id}`,
          created_at: "2026-07-01T00:00:00.000Z",
          event: run.event,
          name: run.name,
        })),
    ),
    getGitRef: vi.fn(async () => ({
      object: { sha: input.tipSha ?? "tip".repeat(8).slice(0, 40) },
    })),
  };
}

describe("inspectQuietWindow", () => {
  it("fails closed without a prior polling sample", async () => {
    const client = mockClient({ runsByWorkflow: {} });
    const result = await inspectQuietWindow({
      client: client as never,
      stateRepository: { owner: "o", repo: "r" },
      priorObservation: null,
    });
    expect(result.quiet).toBe(false);
    expect(result.failClosedReason).toBe("insufficient_polling_samples");
    expect(result.tipSha).toBeTruthy();
  });

  it("reports quiet when two samples have no active runs", async () => {
    const client = mockClient({ runsByWorkflow: {} });
    const prior = {
      observedAt: "2026-07-01T00:00:00.000Z",
      activeRunIds: [],
    };
    const result = await inspectQuietWindow({
      client: client as never,
      stateRepository: { owner: "o", repo: "r" },
      priorObservation: prior,
      observedAt: "2026-07-01T00:00:05.000Z",
    });
    expect(result.quiet).toBe(true);
    expect(result.failClosedReason).toBeNull();
    expect(result.activeRuns).toHaveLength(0);
  });

  it("reports active workflow runs and fail-closed reason", async () => {
    const client = mockClient({
      runsByWorkflow: {
        "harness-auto-runner.yml": [
          {
            id: 42,
            status: "in_progress",
            event: "workflow_dispatch",
            name: "Harness Auto Runner",
          },
        ],
      },
    });
    const result = await inspectQuietWindow({
      client: client as never,
      priorObservation: {
        observedAt: "2026-07-01T00:00:00.000Z",
        activeRunIds: [],
      },
    });
    expect(result.quiet).toBe(false);
    expect(result.failClosedReason).toBe("active_workflow_runs");
    expect(result.activeRuns).toEqual([
      expect.objectContaining({
        id: 42,
        status: "in_progress",
        event: "workflow_dispatch",
      }),
    ]);
  });

  it("fails closed when prior sample had active runs", async () => {
    const client = mockClient({ runsByWorkflow: {} });
    const result = await inspectQuietWindow({
      client: client as never,
      priorObservation: {
        observedAt: "2026-07-01T00:00:00.000Z",
        activeRunIds: [99],
      },
    });
    expect(result.quiet).toBe(false);
    expect(result.failClosedReason).toBe("prior_sample_had_active_runs");
  });

  it("waitAndInspectQuietWindow double-samples with poll gap", async () => {
    const client = mockClient({ runsByWorkflow: {} });
    const sleep = vi.fn(async () => undefined);
    const result = await waitAndInspectQuietWindow({
      client: client as never,
      stateRepository: { owner: "o", repo: "r" },
      pollGapMs: 1,
      sleep,
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(sleep).toHaveBeenCalledWith(1);
    expect(result.quiet).toBe(true);
    expect(result.priorObservation.activeRunIds).toEqual([]);
    expect(client.listWorkflowRuns).toHaveBeenCalled();
  });
});
