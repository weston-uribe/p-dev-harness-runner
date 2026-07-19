import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createToolCallTracker,
  emitIncompleteToolEvents,
  normalizeCursorSdkMessage,
  type CursorSdkMessage,
} from "../../src/evaluation/telemetry/normalize-cursor.js";
import type { TelemetryCorrelationContext } from "../../src/evaluation/telemetry/types.js";
import { unavailableCost } from "../../src/evaluation/telemetry/cost.js";
import { buildUsageRecord } from "../../src/evaluation/telemetry/cost.js";
import { sanitizeToolArgsSummary } from "../../src/evaluation/telemetry/redact.js";
import { allowsLangfuseContentProjection } from "../../src/evaluation/telemetry/profiles.js";
import { validateTelemetryEvent } from "../../src/evaluation/telemetry/validate.js";
import { deriveTelemetryEventId } from "../../src/evaluation/telemetry/ids.js";
import { AGENT_TELEMETRY_SCHEMA_VERSION } from "../../src/evaluation/telemetry/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cursor",
);

const ctx: TelemetryCorrelationContext = {
  evaluationSessionId: "session-1",
  harnessRunId: "run-1",
  phaseExecutionId: "phase-exec-1",
  phase: "implementation",
  provider: "cursor",
  cursorAgentId: "bc-agent-1",
  cursorRunId: "run-1",
};

describe("Cursor SDK message normalization", () => {
  it("normalizes fixture tool start/complete and usage", async () => {
    const raw = JSON.parse(
      await readFile(path.join(fixturesDir, "sdk-messages.json"), "utf8"),
    ) as { messages: CursorSdkMessage[] };
    const tools = createToolCallTracker();
    const events = raw.messages.flatMap((m) =>
      normalizeCursorSdkMessage(m, ctx, tools, "2026-07-18T00:00:00.000Z"),
    );
    const started = events.filter((e) => e.kind === "tool_call_started");
    const finished = events.filter((e) => e.kind === "tool_call_finished");
    const usage = events.filter((e) => e.kind === "model_usage");
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(finished.some((e) => e.payload.callId === "call-shell-1")).toBe(true);
    expect(usage[0]?.payload.usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 10,
      cost: { costSource: "unavailable" },
    });
    for (const event of events) {
      expect(validateTelemetryEvent(event).ok).toBe(true);
      expect(event.evaluationSessionId).toBe("session-1");
      expect(event).not.toHaveProperty("traceId");
    }
  });

  it("marks unmatched tool starts incomplete without synthesizing success", () => {
    const tools = createToolCallTracker();
    normalizeCursorSdkMessage(
      {
        type: "tool_call",
        call_id: "call-x",
        name: "read",
        status: "running",
        args: { path: "src/a.ts" },
        agent_id: "a",
        run_id: "r",
      },
      ctx,
      tools,
      "2026-07-18T00:00:00.000Z",
    );
    const incomplete = emitIncompleteToolEvents(
      ctx,
      tools,
      "2026-07-18T00:00:01.000Z",
    );
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.payload.status).toBe("incomplete");
    expect(incomplete[0]?.payload.status).not.toBe("completed");
  });

  it("redacts secrets in tool args summaries", () => {
    const { summary, redactionStatus } = sanitizeToolArgsSummary({
      token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      cmd: "echo hi",
    });
    expect(summary).toContain("[REDACTED]");
    expect(redactionStatus).toMatch(/redacted/);
  });

  it("reports costSource unavailable and does not invent estimates", () => {
    expect(unavailableCost()).toEqual({
      costSource: "unavailable",
      costUnavailableReason: "provider_did_not_report",
    });
    const usage = buildUsageRecord({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
    });
    expect(usage?.cost.costSource).toBe("unavailable");
    expect(usage?.cost.costUnavailableReason).toBeTruthy();
    expect(usage?.estimatedCostUsd).toBeUndefined();
    expect(usage?.providerReportedCostUsd).toBeUndefined();
  });

  it("gates Langfuse content projection by profile only", () => {
    expect(allowsLangfuseContentProjection("metadata-v1")).toBe(false);
    expect(allowsLangfuseContentProjection("content-v1")).toBe(true);
  });

  it("uses deterministic event ids", () => {
    const a = deriveTelemetryEventId("phase-1", "tool_call_started", "c1:started");
    const b = deriveTelemetryEventId("phase-1", "tool_call_started", "c1:started");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("requires canonical correlation fields", () => {
    const bad = validateTelemetryEvent({
      schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
      eventId: "e1",
      kind: "timing_milestone",
      payload: {},
    });
    expect(bad.ok).toBe(false);
  });
});
