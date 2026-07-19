import { describe, expect, it, vi } from "vitest";
import { cancelCursorRun } from "../../src/cursor/run-cleanup.js";
import { EventLogger } from "../../src/artifacts/events.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("cancelCursorRun", () => {
  it("cancels when SDK supports cancel", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-cancel-"));
    const events = new EventLogger(dir);
    await events.init();

    const run = {
      id: "run-1",
      supports: vi.fn().mockReturnValue(true),
      unsupportedReason: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const outcome = await cancelCursorRun(run, events);
    expect(outcome).toBe("cancelled");
    expect(run.cancel).toHaveBeenCalledTimes(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("records cursor_cancel_unavailable when cancel is unsupported", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-cancel-"));
    const events = new EventLogger(dir);
    await events.init();
    const logSpy = vi.spyOn(events, "log");

    const run = {
      id: "run-2",
      supports: vi.fn().mockReturnValue(false),
      unsupportedReason: vi.fn().mockReturnValue("cloud runs cannot be cancelled"),
      cancel: vi.fn(),
    };

    const outcome = await cancelCursorRun(run, events);
    expect(outcome).toBe("cancel_unavailable");
    expect(run.cancel).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "cursor_cancel_unavailable",
      "warn",
      expect.objectContaining({ runId: "run-2" }),
    );

    await rm(dir, { recursive: true, force: true });
  });
});
