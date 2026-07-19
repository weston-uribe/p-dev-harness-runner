import { deriveTelemetryEventId } from "./ids.js";
import { buildUsageRecord } from "./cost.js";
import {
  sanitizeToolArgsSummary,
  sanitizeToolResultSummary,
} from "./redact.js";
import {
  classifyToolMutation,
  extractRepoRelativePath,
} from "./tool-classify.js";
import {
  AGENT_TELEMETRY_SCHEMA_VERSION,
  type AgentTelemetryEvent,
  type TelemetryCorrelationContext,
  type ToolCallStatus,
} from "./types.js";

/** Minimal structural type matching @cursor/sdk SDKMessage without importing runtime. */
export type CursorSdkMessage = {
  type: string;
  agent_id?: string;
  run_id?: string;
  call_id?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
  request_id?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  model?: { id?: string };
  /** Assistant/user payload or status string depending on message type. */
  message?: unknown;
  text?: string;
};

export interface ToolCallTracker {
  /** callId → startedAt ISO */
  startedAt: Map<string, string>;
  /** callIds that reached completed/error */
  terminal: Set<string>;
}

export function createToolCallTracker(): ToolCallTracker {
  return { startedAt: new Map(), terminal: new Set() };
}

function envelope(
  ctx: TelemetryCorrelationContext,
  kind: AgentTelemetryEvent["kind"],
  discriminator: string,
  payload: Record<string, unknown>,
  timestamp: string,
): AgentTelemetryEvent {
  return {
    schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
    eventId: deriveTelemetryEventId(ctx.phaseExecutionId, kind, discriminator),
    evaluationSessionId: ctx.evaluationSessionId,
    harnessRunId: ctx.harnessRunId,
    phaseExecutionId: ctx.phaseExecutionId,
    phase: ctx.phase,
    provider: ctx.provider,
    timestamp,
    providerTraceId: ctx.providerTraceId,
    cursorAgentId: ctx.cursorAgentId ?? undefined,
    cursorRunId: ctx.cursorRunId ?? undefined,
    cursorRequestId: ctx.cursorRequestId,
    kind,
    payload,
  };
}

function mapToolStatus(status: string | undefined): ToolCallStatus {
  if (status === "running") return "started";
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  return "incomplete";
}

/**
 * Normalize a single Cursor SDKMessage into zero or more canonical events.
 * Does not synthesize completions for unmatched tool starts.
 */
export function normalizeCursorSdkMessage(
  message: CursorSdkMessage,
  ctx: TelemetryCorrelationContext,
  tools: ToolCallTracker,
  timestamp: string = new Date().toISOString(),
): AgentTelemetryEvent[] {
  const events: AgentTelemetryEvent[] = [];
  const agentId = message.agent_id ?? ctx.cursorAgentId;
  const runId = message.run_id ?? ctx.cursorRunId;
  const baseCtx: TelemetryCorrelationContext = {
    ...ctx,
    cursorAgentId: agentId,
    cursorRunId: runId,
  };

  switch (message.type) {
    case "request": {
      if (typeof message.request_id === "string") {
        events.push(
          envelope(
            { ...baseCtx, cursorRequestId: message.request_id },
            "timing_milestone",
            `request:${message.request_id}`,
            { milestone: "request_id", requestId: message.request_id },
            timestamp,
          ),
        );
      }
      break;
    }
    case "system": {
      if (message.model?.id) {
        events.push(
          envelope(
            baseCtx,
            "timing_milestone",
            `system-model:${message.model.id}`,
            { milestone: "system_model", modelId: message.model.id },
            timestamp,
          ),
        );
      }
      break;
    }
    case "assistant": {
      const msg = message.message as
        | { content?: Array<{ type?: string; text?: string }> }
        | undefined;
      const textParts =
        msg?.content
          ?.filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string) ?? [];
      const joined = textParts.join("\n");
      events.push(
        envelope(
          baseCtx,
          "assistant_output",
          `assistant:${timestamp}:${textParts.length}`,
          {
            textBlockCount: textParts.length,
            charCount: joined.length,
            hasAssistantOutput: textParts.length > 0,
            // Bounded preview for content-v1 Langfuse projection; full body stays in artifacts
            ...(joined
              ? {
                  contentPreview: joined.slice(0, 8000),
                }
              : {}),
          },
          timestamp,
        ),
      );
      break;
    }
    case "tool_call": {
      const callId = message.call_id ?? "unknown";
      const name = message.name ?? "unknown";
      const mapped = mapToolStatus(message.status);
      const argsSan = sanitizeToolArgsSummary(message.args);
      const resultSan = sanitizeToolResultSummary(message.result);
      const mutationClass = classifyToolMutation(name);
      const filePath = extractRepoRelativePath(message.args);

      if (mapped === "started") {
        if (!tools.startedAt.has(callId)) {
          tools.startedAt.set(callId, timestamp);
        }
        events.push(
          envelope(
            baseCtx,
            "tool_call_started",
            `${callId}:started`,
            {
              callId,
              toolName: name,
              status: mapped,
              mutationClass,
              argsSummary: argsSan.summary,
              redactionStatus: argsSan.redactionStatus,
              filePath,
              truncated: message.truncated ?? null,
            },
            timestamp,
          ),
        );
      } else if (mapped === "completed" || mapped === "error") {
        tools.terminal.add(callId);
        const started = tools.startedAt.get(callId);
        const durationMs =
          started != null
            ? Math.max(0, Date.parse(timestamp) - Date.parse(started))
            : undefined;
        events.push(
          envelope(
            baseCtx,
            "tool_call_finished",
            `${callId}:${mapped}`,
            {
              callId,
              toolName: name,
              status: mapped,
              mutationClass,
              startedAt: started ?? null,
              endedAt: timestamp,
              durationMs: durationMs ?? null,
              argsSummary: argsSan.summary,
              resultSummary: resultSan.summary,
              redactionStatus: resultSan.redactionStatus,
              exitCode: resultSan.exitCode ?? null,
              stdoutByteCount: resultSan.stdoutByteCount ?? null,
              stderrByteCount: resultSan.stderrByteCount ?? null,
              filePath,
              truncated: message.truncated ?? null,
            },
            timestamp,
          ),
        );
        events.push(
          envelope(
            baseCtx,
            "tool_result",
            `${callId}:result:${mapped}`,
            {
              callId,
              toolName: name,
              status: mapped,
              exitCode: resultSan.exitCode ?? null,
              stdoutByteCount: resultSan.stdoutByteCount ?? null,
              stderrByteCount: resultSan.stderrByteCount ?? null,
              resultSummary: resultSan.summary,
              redactionStatus: resultSan.redactionStatus,
            },
            timestamp,
          ),
        );
      }
      break;
    }
    case "usage": {
      const usage = buildUsageRecord(
        message.usage,
        typeof (message as { model?: string }).model === "string"
          ? (message as { model?: string }).model
          : undefined,
      );
      events.push(
        envelope(
          baseCtx,
          "model_usage",
          `usage:${timestamp}`,
          {
            usage,
            usageAggregation: "cursor_turn",
          },
          timestamp,
        ),
      );
      break;
    }
    case "status": {
      if (message.status === "CANCELLED") {
        events.push(
          envelope(
            baseCtx,
            "cancellation",
            `status:${message.status}:${timestamp}`,
            { status: message.status },
            timestamp,
          ),
        );
      } else if (message.status === "ERROR") {
        events.push(
          envelope(
            baseCtx,
            "error",
            `status:${message.status}:${timestamp}`,
            { status: message.status },
            timestamp,
          ),
        );
      } else {
        events.push(
          envelope(
            baseCtx,
            "timing_milestone",
            `status:${message.status}:${timestamp}`,
            { milestone: "cursor_status", status: message.status },
            timestamp,
          ),
        );
      }
      break;
    }
    default:
      // thinking / user / task — timing only, no content duplication
      events.push(
        envelope(
          baseCtx,
          "timing_milestone",
          `${message.type}:${timestamp}`,
          { milestone: "cursor_event", cursorEventType: message.type },
          timestamp,
        ),
      );
      break;
  }

  return events;
}

/** Emit incomplete markers for tool calls that never reached terminal status. */
export function emitIncompleteToolEvents(
  ctx: TelemetryCorrelationContext,
  tools: ToolCallTracker,
  timestamp: string = new Date().toISOString(),
): AgentTelemetryEvent[] {
  const events: AgentTelemetryEvent[] = [];
  for (const [callId, startedAt] of tools.startedAt) {
    if (tools.terminal.has(callId)) continue;
    events.push(
      envelope(
        ctx,
        "tool_call_finished",
        `${callId}:incomplete`,
        {
          callId,
          status: "incomplete",
          startedAt,
          endedAt: timestamp,
          completenessNote:
            "Cursor stream ended without matching completed/error tool event",
        },
        timestamp,
      ),
    );
  }
  return events;
}
