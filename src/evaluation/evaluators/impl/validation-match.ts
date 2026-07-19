import type { AgentTelemetryEvent } from "../../telemetry/types.js";
import type { EvaluatorOutcome } from "../types.js";
import { failOutcome, passOutcome, skippedOutcome } from "../outcomes.js";

export const VALIDATION_MATCH_RULE_VERSION = "validation-match-v1";

/** Canonical expected validation command tokens (exact argv[0] or exact command string). */
const CANONICAL_COMMANDS = [
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "pnpm test",
  "pnpm run test",
  "yarn test",
] as const;

export interface NormalizedShellToolCall {
  callId: string;
  command: string | null;
  truncated: boolean;
  started: boolean;
  finished: boolean;
  exitCode: number | null;
  ambiguous: boolean;
}

function extractCommand(payload: Record<string, unknown>): {
  command: string | null;
  truncated: boolean;
  ambiguous: boolean;
} {
  const argsSummary =
    typeof payload.argsSummary === "string" ? payload.argsSummary : null;
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName.toLowerCase() : "";
  const truncated = payload.truncated === true;
  if (!toolName.includes("shell") && !toolName.includes("bash")) {
    return { command: null, truncated, ambiguous: false };
  }
  if (!argsSummary) {
    return { command: null, truncated, ambiguous: true };
  }
  // Reject fuzzy containment matching — require exact canonical command string.
  const normalized = argsSummary.trim().replace(/\s+/g, " ");
  if (truncated || normalized.includes("&&") || normalized.includes("|")) {
    return { command: normalized, truncated: true, ambiguous: true };
  }
  return { command: normalized, truncated, ambiguous: false };
}

export function normalizeShellToolCalls(
  events: AgentTelemetryEvent[],
): NormalizedShellToolCall[] {
  const byCall = new Map<string, NormalizedShellToolCall>();
  for (const event of events) {
    if (
      event.kind !== "tool_call_started" &&
      event.kind !== "tool_call_finished" &&
      event.kind !== "tool_result"
    ) {
      continue;
    }
    const payload = event.payload ?? {};
    const callId =
      typeof payload.callId === "string" ? payload.callId : null;
    if (!callId) continue;
    const existing = byCall.get(callId) ?? {
      callId,
      command: null,
      truncated: false,
      started: false,
      finished: false,
      exitCode: null,
      ambiguous: false,
    };
    if (event.kind === "tool_call_started") {
      existing.started = true;
      const extracted = extractCommand(payload);
      existing.command = extracted.command;
      existing.truncated = extracted.truncated;
      existing.ambiguous = existing.ambiguous || extracted.ambiguous;
    } else {
      existing.finished = true;
      if (typeof payload.exitCode === "number") {
        existing.exitCode = payload.exitCode;
      }
      if (!existing.command) {
        const extracted = extractCommand(payload);
        existing.command = extracted.command;
        existing.truncated = extracted.truncated;
        existing.ambiguous = existing.ambiguous || extracted.ambiguous;
      }
    }
    byCall.set(callId, existing);
  }
  return [...byCall.values()];
}

export function expectedValidationCommandsFromEvidence(params: {
  promptContent: string | null;
  manifestValidationSummary: string | null;
}): { commands: string[]; ambiguous: boolean } {
  const found = new Set<string>();
  const sources = [params.promptContent, params.manifestValidationSummary]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
  if (!sources) {
    return { commands: [], ambiguous: false };
  }
  for (const cmd of CANONICAL_COMMANDS) {
    // Exact line or fenced mention — not substring of larger prose sentence.
    const patterns = [
      new RegExp(`^\\s*${escapeRegExp(cmd)}\\s*$`, "im"),
      new RegExp(`\\\`${escapeRegExp(cmd)}\\\``, "i"),
      new RegExp(`"${escapeRegExp(cmd)}"`, "i"),
    ];
    if (patterns.some((re) => re.test(sources))) {
      found.add(cmd);
    }
  }
  return { commands: [...found].sort(), ambiguous: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function evaluateValidationObserved(params: {
  expected: string[];
  toolCalls: NormalizedShellToolCall[];
}): EvaluatorOutcome {
  if (params.expected.length === 0) {
    return skippedOutcome(
      "insufficient_evidence",
      "expected_validation_commands_unavailable",
      "No canonical expected validation commands could be extracted from prompt/config evidence.",
    );
  }
  const ambiguous = params.toolCalls.some((c) => {
    if (c.ambiguous) return true;
    if (c.command == null) return false;
    const command = c.command;
    return params.expected.some((e) => command !== e && command.includes(e));
  });
  if (ambiguous) {
    return skippedOutcome(
      "insufficient_evidence",
      "validation_command_match_ambiguous",
      "Tool telemetry command matching is ambiguous (wrappers, composition, or truncation).",
    );
  }
  const observedExact = new Set(
    params.toolCalls
      .filter((c) => c.command != null && params.expected.includes(c.command))
      .map((c) => c.command as string),
  );
  const missing = params.expected.filter((c) => !observedExact.has(c));
  if (missing.length > 0) {
    // Cannot prove execution — skip rather than fail when telemetry cannot show the command.
    const anyShell = params.toolCalls.some((c) => c.command != null);
    if (!anyShell) {
      return skippedOutcome(
        "insufficient_evidence",
        "validation_telemetry_unavailable",
        "No shell tool-call telemetry available to prove validation command execution.",
      );
    }
    return skippedOutcome(
      "insufficient_evidence",
      "validation_commands_not_proven",
      `Expected validation commands not proven in tool telemetry: ${missing.join(", ")}.`,
    );
  }
  return passOutcome(
    "validation_commands_observed",
    `All expected validation commands observed exactly (${VALIDATION_MATCH_RULE_VERSION}).`,
  );
}

export function evaluateValidationSucceeded(params: {
  expected: string[];
  toolCalls: NormalizedShellToolCall[];
}): EvaluatorOutcome {
  const observed = evaluateValidationObserved(params);
  if (observed.status !== "pass") return observed;

  const relevant = params.toolCalls.filter(
    (c) => c.command != null && params.expected.includes(c.command),
  );
  for (const call of relevant) {
    if (!call.finished || call.exitCode == null) {
      return skippedOutcome(
        "insufficient_evidence",
        "validation_completion_unproven",
        `Command ${call.command} lacks correlated completion/exit status.`,
      );
    }
    if (call.exitCode !== 0) {
      return failOutcome(
        "validation_command_failed",
        `Required validation command failed: ${call.command} (exit ${call.exitCode}).`,
      );
    }
  }
  return passOutcome(
    "validation_commands_succeeded",
    "All required validation commands completed with exit code 0.",
  );
}
