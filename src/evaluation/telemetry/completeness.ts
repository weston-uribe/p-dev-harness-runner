import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTelemetryCompletenessPath } from "../../artifacts/paths.js";
import type {
  AgentTelemetryCompleteness,
  AgentTelemetryEventCounts,
  AgentTelemetryEventKind,
} from "./types.js";
import { warnOnce } from "../warn.js";

export function createEmptyEventCounts(): AgentTelemetryEventCounts {
  return {
    total: 0,
    byKind: {},
    toolStarted: 0,
    toolFinished: 0,
    toolError: 0,
    toolIncomplete: 0,
  };
}

export function createEmptyCompleteness(
  options: { revisionRequiresPmFeedback?: boolean } = {},
): AgentTelemetryCompleteness {
  return {
    trace_input_present: false,
    trace_output_present: false,
    agent_input_present: false,
    agent_output_present: false,
    model_present: false,
    usage_present: false,
    tool_events_present: false,
    tool_event_completion_rate: null,
    prompt_provenance_present: false,
    skill_provenance_present: false,
    pm_feedback_present: options.revisionRequiresPmFeedback ? false : null,
  };
}

export class CompletenessTracker {
  readonly counts = createEmptyEventCounts();
  readonly completeness: AgentTelemetryCompleteness;
  private toolCallIds = new Set<string>();
  private toolTerminalIds = new Set<string>();

  constructor(options: { revisionRequiresPmFeedback?: boolean } = {}) {
    this.completeness = createEmptyCompleteness(options);
  }

  recordKind(kind: AgentTelemetryEventKind, payload?: Record<string, unknown>): void {
    this.counts.total += 1;
    this.counts.byKind[kind] = (this.counts.byKind[kind] ?? 0) + 1;

    switch (kind) {
      case "prompt_provenance":
        this.completeness.prompt_provenance_present = true;
        this.completeness.agent_input_present = true;
        break;
      case "assistant_output":
      case "agent_run_finished":
        if (payload?.artifactRef || payload?.hasAssistantOutput) {
          this.completeness.agent_output_present = true;
        }
        break;
      case "model_usage":
        this.completeness.usage_present = true;
        if (payload?.modelId) this.completeness.model_present = true;
        break;
      case "skill_provenance":
        this.completeness.skill_provenance_present = true;
        break;
      case "pm_feedback":
        this.completeness.pm_feedback_present = true;
        this.completeness.trace_input_present = true;
        break;
      case "tool_call_started": {
        this.counts.toolStarted += 1;
        this.completeness.tool_events_present = true;
        const callId = typeof payload?.callId === "string" ? payload.callId : null;
        if (callId) this.toolCallIds.add(callId);
        break;
      }
      case "tool_call_finished":
      case "tool_result": {
        const status = payload?.status;
        if (status === "error") this.counts.toolError += 1;
        else this.counts.toolFinished += 1;
        const callId = typeof payload?.callId === "string" ? payload.callId : null;
        if (callId) this.toolTerminalIds.add(callId);
        break;
      }
      default:
        break;
    }
    this.refreshToolCompletionRate();
  }

  markModelPresent(present: boolean): void {
    if (present) this.completeness.model_present = true;
  }

  markUsagePresent(present: boolean): void {
    if (present) this.completeness.usage_present = true;
  }

  markTraceInput(present: boolean): void {
    if (present) this.completeness.trace_input_present = true;
  }

  markTraceOutput(present: boolean): void {
    if (present) this.completeness.trace_output_present = true;
  }

  markAgentOutput(present: boolean): void {
    if (present) this.completeness.agent_output_present = true;
  }

  finalizeIncompleteTools(): void {
    for (const id of this.toolCallIds) {
      if (!this.toolTerminalIds.has(id)) {
        this.counts.toolIncomplete += 1;
      }
    }
    this.refreshToolCompletionRate();
  }

  private refreshToolCompletionRate(): void {
    const started = this.toolCallIds.size;
    if (started === 0) {
      this.completeness.tool_event_completion_rate = null;
      return;
    }
    this.completeness.tool_event_completion_rate =
      this.toolTerminalIds.size / started;
  }

  snapshot(): {
    counts: AgentTelemetryEventCounts;
    completeness: AgentTelemetryCompleteness;
  } {
    return {
      counts: { ...this.counts, byKind: { ...this.counts.byKind } },
      completeness: { ...this.completeness },
    };
  }
}

export async function writeTelemetryCompletenessArtifact(
  runDirectory: string,
  completeness: AgentTelemetryCompleteness,
  counts: AgentTelemetryEventCounts,
): Promise<void> {
  try {
    const filePath = getTelemetryCompletenessPath(runDirectory);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          completeness,
          eventCounts: counts,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    warnOnce(
      "telemetry-completeness-write",
      `Failed to write telemetry completeness: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Flatten completeness into bounded metadata keys for Langfuse. */
export function completenessToMetadata(
  completeness: AgentTelemetryCompleteness,
): Record<string, unknown> {
  return {
    telemetryCompletenessTraceInput: completeness.trace_input_present,
    telemetryCompletenessTraceOutput: completeness.trace_output_present,
    telemetryCompletenessAgentInput: completeness.agent_input_present,
    telemetryCompletenessAgentOutput: completeness.agent_output_present,
    telemetryCompletenessModel: completeness.model_present,
    telemetryCompletenessUsage: completeness.usage_present,
    telemetryCompletenessToolEvents: completeness.tool_events_present,
    telemetryCompletenessToolCompletionRate:
      completeness.tool_event_completion_rate,
    telemetryCompletenessPromptProvenance:
      completeness.prompt_provenance_present,
    telemetryCompletenessSkillProvenance: completeness.skill_provenance_present,
    ...(completeness.pm_feedback_present !== null
      ? {
          telemetryCompletenessPmFeedback: completeness.pm_feedback_present,
        }
      : {}),
  };
}
