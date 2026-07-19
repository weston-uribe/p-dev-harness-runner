import {
  CompletenessTracker,
  writeTelemetryCompletenessArtifact,
} from "./completeness.js";
import { deriveTelemetryEventId } from "./ids.js";
import {
  createToolCallTracker,
  emitIncompleteToolEvents,
  normalizeCursorSdkMessage,
  type CursorSdkMessage,
  type ToolCallTracker,
} from "./normalize-cursor.js";
import { appendTelemetryEvent } from "./writer.js";
import {
  AGENT_TELEMETRY_SCHEMA_VERSION,
  type AgentTelemetryEvent,
  type OnTelemetryEvent,
  type TelemetryCorrelationContext,
} from "./types.js";
import { warnOnce } from "../warn.js";

export interface AgentTelemetrySessionOptions {
  runDirectory: string;
  correlation: TelemetryCorrelationContext;
  onTelemetryEvent?: OnTelemetryEvent;
  revisionRequiresPmFeedback?: boolean;
}

/**
 * Streaming telemetry session: normalize → validate/redact/bound → JSONL →
 * optional Langfuse forward → completeness update.
 */
export class AgentTelemetrySession {
  readonly correlation: TelemetryCorrelationContext;
  readonly tracker: CompletenessTracker;
  readonly tools: ToolCallTracker;
  private readonly runDirectory: string;
  private readonly externalOnEvent?: OnTelemetryEvent;
  private sequence = 0;

  constructor(options: AgentTelemetrySessionOptions) {
    this.runDirectory = options.runDirectory;
    this.correlation = options.correlation;
    this.externalOnEvent = options.onTelemetryEvent;
    this.tracker = new CompletenessTracker({
      revisionRequiresPmFeedback: options.revisionRequiresPmFeedback,
    });
    this.tools = createToolCallTracker();
  }

  async emit(event: AgentTelemetryEvent): Promise<void> {
    const written = await appendTelemetryEvent(this.runDirectory, event);
    if (!written) return;
    this.tracker.recordKind(event.kind, event.payload);
    if (this.externalOnEvent) {
      try {
        await this.externalOnEvent(event);
      } catch (error) {
        warnOnce(
          "telemetry-forward",
          `Telemetry forward failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async handleCursorSdkMessage(message: CursorSdkMessage): Promise<void> {
    const timestamp = new Date().toISOString();
    const events = normalizeCursorSdkMessage(
      message,
      this.correlation,
      this.tools,
      timestamp,
    );
    for (const event of events) {
      // Ensure uniqueness across rapid identical messages
      if (event.kind === "timing_milestone") {
        this.sequence += 1;
        event.eventId = deriveTelemetryEventId(
          this.correlation.phaseExecutionId,
          event.kind,
          `${event.payload.milestone ?? "m"}:${this.sequence}`,
        );
      }
      await this.emit(event);
      if (typeof message.request_id === "string") {
        this.correlation.cursorRequestId = message.request_id;
      }
      if (message.agent_id) this.correlation.cursorAgentId = message.agent_id;
      if (message.run_id) this.correlation.cursorRunId = message.run_id;
    }
  }

  async emitRunStarted(payload: Record<string, unknown> = {}): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.emit({
      schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
      eventId: deriveTelemetryEventId(
        this.correlation.phaseExecutionId,
        "agent_run_started",
        "start",
      ),
      evaluationSessionId: this.correlation.evaluationSessionId,
      harnessRunId: this.correlation.harnessRunId,
      phaseExecutionId: this.correlation.phaseExecutionId,
      phase: this.correlation.phase,
      provider: this.correlation.provider,
      timestamp,
      providerTraceId: this.correlation.providerTraceId,
      cursorAgentId: this.correlation.cursorAgentId,
      cursorRunId: this.correlation.cursorRunId,
      cursorRequestId: this.correlation.cursorRequestId,
      kind: "agent_run_started",
      payload,
    });
  }

  async emitRunFinished(payload: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    if (payload.hasAssistantOutput) {
      this.tracker.markAgentOutput(true);
    }
    if (payload.modelId) this.tracker.markModelPresent(true);
    if (payload.usage) this.tracker.markUsagePresent(true);

    await this.emit({
      schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
      eventId: deriveTelemetryEventId(
        this.correlation.phaseExecutionId,
        "agent_run_finished",
        "finish",
      ),
      evaluationSessionId: this.correlation.evaluationSessionId,
      harnessRunId: this.correlation.harnessRunId,
      phaseExecutionId: this.correlation.phaseExecutionId,
      phase: this.correlation.phase,
      provider: this.correlation.provider,
      timestamp,
      providerTraceId: this.correlation.providerTraceId,
      cursorAgentId: this.correlation.cursorAgentId,
      cursorRunId: this.correlation.cursorRunId,
      cursorRequestId: this.correlation.cursorRequestId,
      kind: "agent_run_finished",
      payload,
    });
  }

  async finalize(): Promise<{
    counts: ReturnType<CompletenessTracker["snapshot"]>["counts"];
    completeness: ReturnType<CompletenessTracker["snapshot"]>["completeness"];
  }> {
    const timestamp = new Date().toISOString();
    const incomplete = emitIncompleteToolEvents(
      this.correlation,
      this.tools,
      timestamp,
    );
    for (const event of incomplete) {
      await this.emit(event);
    }
    this.tracker.finalizeIncompleteTools();
    const snap = this.tracker.snapshot();

    await this.emit({
      schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
      eventId: deriveTelemetryEventId(
        this.correlation.phaseExecutionId,
        "telemetry_completeness",
        "terminal",
      ),
      evaluationSessionId: this.correlation.evaluationSessionId,
      harnessRunId: this.correlation.harnessRunId,
      phaseExecutionId: this.correlation.phaseExecutionId,
      phase: this.correlation.phase,
      provider: this.correlation.provider,
      timestamp,
      providerTraceId: this.correlation.providerTraceId,
      cursorAgentId: this.correlation.cursorAgentId,
      cursorRunId: this.correlation.cursorRunId,
      cursorRequestId: this.correlation.cursorRequestId,
      kind: "telemetry_completeness",
      payload: {
        completeness: snap.completeness,
        eventCounts: snap.counts,
      },
    });

    await writeTelemetryCompletenessArtifact(
      this.runDirectory,
      snap.completeness,
      snap.counts,
    );

    return snap;
  }
}
