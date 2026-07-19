import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentTelemetrySession } from "../../src/evaluation/telemetry/session.js";
import { getAgentTelemetryPath } from "../../src/artifacts/paths.js";
import type { CursorSdkMessage } from "../../src/evaluation/telemetry/normalize-cursor.js";

describe("agent telemetry session writer", () => {
  it("appends normalized events deterministically and tracks completeness", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "telemetry-"));
    const forwarded: string[] = [];
    const session = new AgentTelemetrySession({
      runDirectory: dir,
      correlation: {
        evaluationSessionId: "sess",
        harnessRunId: "harness-1",
        phaseExecutionId: "phase-1",
        phase: "implementation",
        provider: "cursor",
      },
      onTelemetryEvent: (e) => {
        forwarded.push(e.kind);
      },
    });

    await session.emitRunStarted();
    const messages: CursorSdkMessage[] = [
      {
        type: "tool_call",
        call_id: "c1",
        name: "shell",
        status: "running",
        args: { command: "npm test" },
        agent_id: "a1",
        run_id: "r1",
      },
      {
        type: "tool_call",
        call_id: "c1",
        name: "shell",
        status: "completed",
        args: { command: "npm test" },
        result: { exitCode: 0, stdout: "ok", stderr: "" },
        agent_id: "a1",
        run_id: "r1",
      },
    ];
    for (const m of messages) {
      await session.handleCursorSdkMessage(m);
    }
    await session.emitRunFinished({
      hasAssistantOutput: true,
      modelId: "composer-2.5",
      usage: { inputTokens: 1, cost: { costSource: "unavailable" } },
    });
    const snap = await session.finalize();

    const lines = (await readFile(getAgentTelemetryPath(dir), "utf8"))
      .trim()
      .split("\n");
    expect(lines.length).toBeGreaterThan(3);
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(parsed.some((e) => e.kind === "telemetry_completeness")).toBe(true);
    expect(snap.completeness.tool_events_present).toBe(true);
    expect(snap.completeness.tool_event_completion_rate).toBe(1);
    expect(snap.completeness.model_present).toBe(true);
    expect(forwarded).toContain("tool_call_started");
    expect(forwarded).toContain("telemetry_completeness");

    // Re-read should be stable JSONL (one object per line)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj.evaluationSessionId).toBe("sess");
      expect(obj.harnessRunId).toBe("harness-1");
      expect(obj.phaseExecutionId).toBe("phase-1");
    }

    await rm(dir, { recursive: true, force: true });
  });
});
