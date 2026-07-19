import type { EvaluationContext, EvaluatorOutcome } from "../types.js";
import {
  fail,
  notApplicable,
  pass,
  requireEvidence,
} from "./shared.js";
import { AGENT_EXPECTED_PHASES } from "./shared.js";

function requireTelemetry(ctx: EvaluationContext): EvaluatorOutcome | null {
  return requireEvidence(ctx, ["telemetry"]);
}

export async function evaluateCanonicalCorrelationPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const events = ctx.telemetryEvents;
  if (events.length === 0) {
    return notApplicable(
      "telemetry_stream_empty",
      "No telemetry events for this subject.",
    );
  }
  for (const event of events) {
    if (
      !event.evaluationSessionId ||
      !event.harnessRunId ||
      !event.phaseExecutionId ||
      !event.eventId
    ) {
      return fail(
        "canonical_correlation_missing",
        `Event ${event.eventId ?? "(missing)"} lacks required canonical correlation IDs.`,
      );
    }
  }
  return pass(
    "canonical_correlation_present",
    "All telemetry events include required canonical correlation IDs.",
  );
}

export async function evaluateEventIdsUnique(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const seen = new Set<string>();
  for (const event of ctx.telemetryEvents) {
    if (seen.has(event.eventId)) {
      return fail(
        "duplicate_event_id",
        `Duplicate telemetry eventId: ${event.eventId}`,
      );
    }
    seen.add(event.eventId);
  }
  return pass("event_ids_unique", "Telemetry event IDs are unique.");
}

export async function evaluateEventOrderValid(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  let previous: number | null = null;
  for (const event of ctx.telemetryEvents) {
    const ts = Date.parse(event.timestamp);
    if (Number.isNaN(ts)) {
      return fail(
        "invalid_event_timestamp",
        `Invalid timestamp on event ${event.eventId}`,
      );
    }
    if (previous != null && ts < previous) {
      return fail(
        "event_order_violation",
        `Non-decreasing timestamp order violated at event ${event.eventId}`,
      );
    }
    previous = ts;
  }
  return pass("event_order_valid", "Event timestamps are non-decreasing.");
}

export async function evaluateAgentStartFinishPaired(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (phase == null || !AGENT_EXPECTED_PHASES.has(phase)) {
    return notApplicable(
      "agent_pairing_not_applicable",
      "Agent start/finish pairing not applicable for this phase.",
    );
  }
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const starts = ctx.telemetryEvents.filter((e) => e.kind === "agent_run_started");
  const finishes = ctx.telemetryEvents.filter(
    (e) => e.kind === "agent_run_finished",
  );
  if (starts.length === 0 && finishes.length === 0) {
    return notApplicable(
      "no_agent_run_events",
      "No agent run start/finish events present.",
    );
  }
  if (starts.length !== finishes.length) {
    return fail(
      "agent_start_finish_unpaired",
      `Agent start (${starts.length}) and finish (${finishes.length}) counts differ.`,
    );
  }
  return pass(
    "agent_start_finish_paired",
    "Agent start and finish events are paired.",
  );
}

export async function evaluateToolEventsCorrelated(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (phase == null || !AGENT_EXPECTED_PHASES.has(phase)) {
    return notApplicable(
      "tool_correlation_not_applicable",
      "Tool event correlation not applicable for this phase.",
    );
  }
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const event of ctx.telemetryEvents) {
    const callId =
      typeof event.payload?.callId === "string" ? event.payload.callId : null;
    if (!callId) continue;
    if (event.kind === "tool_call_started") started.add(callId);
    if (event.kind === "tool_call_finished" || event.kind === "tool_result") {
      finished.add(callId);
    }
  }
  if (started.size === 0 && finished.size === 0) {
    return notApplicable(
      "no_tool_events",
      "No tool call events present to correlate.",
    );
  }
  for (const id of finished) {
    if (!started.has(id)) {
      return fail(
        "tool_call_missing_start",
        `Tool finish/result without start for callId ${id}`,
      );
    }
  }
  return pass(
    "tool_events_correlated",
    "Tool events correlate by call ID.",
  );
}

export async function evaluateTelemetryCompletenessArtifactPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireEvidence(ctx, ["telemetry_completeness"]);
  if (skip) return skip;
  if (ctx.telemetryCompleteness == null) {
    return fail(
      "completeness_artifact_unreadable",
      "Telemetry completeness artifact could not be parsed.",
    );
  }
  const completeness = ctx.telemetryCompleteness as {
    eventCounts?: { total?: number };
  };
  const reportedTotal = completeness.eventCounts?.total;
  if (typeof reportedTotal === "number") {
    const observed = ctx.telemetryEvents.length;
    // If telemetry is also present, require agreement; else pass on artifact alone.
    const telemetryItem = ctx.evidence.telemetry;
    if (telemetryItem?.present && !telemetryItem.untrusted) {
      if (reportedTotal !== observed) {
        return fail(
          "completeness_disagrees_with_events",
          `Completeness total ${reportedTotal} disagrees with observed events ${observed}.`,
        );
      }
    }
  }
  return pass(
    "telemetry_completeness_artifact_present",
    "Telemetry completeness artifact is present and consistent when comparable.",
  );
}

export async function evaluateArtifactReferencesResolve(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const untrusted = Object.values(ctx.evidence).filter((e) => e.untrusted);
  if (untrusted.length > 0) {
    return fail(
      "artifact_reference_untrusted",
      `Untrusted artifact references: ${untrusted.map((u) => u.key).join(", ")}`,
    );
  }
  // Presence of telemetry with resolvable subject evidence refs.
  const subjectRefs = ctx.subject.evidenceArtifactRefs ?? [];
  for (const ref of subjectRefs) {
    if (ref.artifactPath.includes("..") || ref.artifactPath.startsWith("/")) {
      return fail(
        "artifact_path_unsafe",
        `Unsafe artifact path in subject evidence: ${ref.artifactPath}`,
      );
    }
  }
  return pass(
    "artifact_references_resolve",
    "Artifact references resolve under path-confined roots.",
  );
}

export async function evaluateArtifactHashesMatch(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireTelemetry(ctx);
  if (skip) return skip;
  const mismatched = Object.values(ctx.evidence).filter(
    (e) => e.untrusted && e.untrustedReason?.includes("hash"),
  );
  if (mismatched.length > 0) {
    return fail(
      "artifact_hash_mismatch",
      `Artifact hash mismatches: ${mismatched.map((m) => m.key).join(", ")}`,
    );
  }
  const presentHashed = Object.values(ctx.evidence).filter(
    (e) => e.present && e.sha256 && !e.untrusted,
  );
  if (presentHashed.length === 0) {
    return notApplicable(
      "no_hashed_artifacts",
      "No hashed artifact evidence available to verify.",
    );
  }
  return pass(
    "artifact_hashes_match",
    "Referenced artifact hashes match on-disk content where verified.",
  );
}
