import {
  hashProviderIdentity,
  isCanonicalProviderIdentityHash,
} from "../../../identity/provider-identity-hash.js";
import type { UsageCandidate } from "../discovery.js";
import type { UsageSegment } from "../canonical.js";
import { resolveCanonicalModelId } from "../model-aliases.js";
import {
  registryEventAttributionSlackMs,
  type ExactTraceTarget,
  type RunOperationBinding,
  type TraceMappingClassification,
  type TraceMappingResult,
} from "./contracts.js";
import { intervalsOverlapHalfOpen } from "./reader.js";

export interface TraceMappingInput {
  segmentKey: string;
  segment: UsageSegment;
  matchedRunOperation: RunOperationBinding;
  candidates: UsageCandidate[];
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function normalizeAgentHashEvidence(input: {
  privateAgentId?: string | null;
  canonicalHash?: string | null;
  displayHash?: string | null;
}): { agentHash: string | null; conflict: boolean } {
  const fromPrivate = input.privateAgentId?.trim()
    ? hashProviderIdentity(input.privateAgentId)
    : null;
  const fromCanonical =
    input.canonicalHash && isCanonicalProviderIdentityHash(input.canonicalHash)
      ? input.canonicalHash
      : null;

  if (fromPrivate && fromCanonical && fromPrivate !== fromCanonical) {
    return { agentHash: null, conflict: true };
  }

  if (fromPrivate) return { agentHash: fromPrivate, conflict: false };
  if (fromCanonical) return { agentHash: fromCanonical, conflict: false };

  // Never treat 12-char display hash as authority.
  void input.displayHash;
  return { agentHash: null, conflict: false };
}

function candidateMatchesRunOperation(
  candidate: UsageCandidate,
  binding: RunOperationBinding,
  segment: UsageSegment,
): { ok: boolean; reason: TraceMappingClassification | null } {
  const identity = normalizeAgentHashEvidence({
    privateAgentId: candidate.cursorAgentId,
    canonicalHash:
      candidate.cursorAgentIdHash && candidate.cursorAgentIdHash.length === 64
        ? candidate.cursorAgentIdHash
        : candidate.cursorAgentId
          ? hashProviderIdentity(candidate.cursorAgentId)
          : null,
    displayHash: segment.cloudAgentIdHash,
  });
  if (identity.conflict) {
    return { ok: false, reason: "trace_identity_conflict" };
  }
  if (!identity.agentHash || identity.agentHash !== binding.agentHash) {
    return { ok: false, reason: "trace_identity_conflict" };
  }

  if (
    binding.linearIssueKey &&
    candidate.issueKey &&
    candidate.issueKey !== binding.linearIssueKey
  ) {
    return { ok: false, reason: "phase_identity_conflict" };
  }
  if (binding.phase && candidate.phase && candidate.phase !== binding.phase) {
    return { ok: false, reason: "phase_identity_conflict" };
  }
  if (
    binding.phaseExecutionId &&
    candidate.phaseExecutionId &&
    candidate.phaseExecutionId !== binding.phaseExecutionId
  ) {
    return { ok: false, reason: "phase_identity_conflict" };
  }
  if (
    binding.harnessRunId &&
    candidate.harnessRunId &&
    candidate.harnessRunId !== binding.harnessRunId
  ) {
    return { ok: false, reason: "phase_identity_conflict" };
  }

  if (!segment.timestampMin || !segment.timestampMax) {
    return { ok: false, reason: "execution_window_conflict" };
  }

  const slack = registryEventAttributionSlackMs;
  const segStart = parseIso(segment.timestampMin);
  const segEnd = parseIso(segment.timestampMax);
  const candStart = parseIso(candidate.windowStart);
  const candEnd = parseIso(candidate.windowEnd);
  if (segStart == null || segEnd == null || candStart == null || candEnd == null) {
    return { ok: false, reason: "execution_window_conflict" };
  }

  const paddedSegStart = new Date(segStart - slack).toISOString();
  const paddedSegEnd = new Date(segEnd + slack).toISOString();
  if (
    !candidate.windowStart ||
    !candidate.windowEnd ||
    !intervalsOverlapHalfOpen(
      paddedSegStart,
      paddedSegEnd,
      candidate.windowStart,
      candidate.windowEnd,
    )
  ) {
    return { ok: false, reason: "execution_window_conflict" };
  }

  if (segment.modelIdCanonical && candidate.model) {
    const candidateCanonical = resolveCanonicalModelId(candidate.model);
    if (candidateCanonical && segment.modelIdCanonical !== candidateCanonical) {
      return { ok: false, reason: "model_identity_conflict" };
    }
  }

  const segmentVariant = segment.sourceMaxMode;
  const candidateVariant = candidate.effectiveVariant;
  if (segmentVariant && candidateVariant && segmentVariant !== candidateVariant) {
    return { ok: false, reason: "variant_identity_conflict" };
  }

  if (binding.runHash && candidate.harnessRunId) {
    // run hash / phase execution identity accepted when present in tracing schema.
    void binding.runHash;
  }

  return { ok: true, reason: null };
}

export function mapHarnessOwnedSegmentToTrace(
  input: TraceMappingInput,
): TraceMappingResult {
  const compatible: UsageCandidate[] = [];
  let conflict: TraceMappingClassification | null = null;

  for (const candidate of input.candidates) {
    const verdict = candidateMatchesRunOperation(
      candidate,
      input.matchedRunOperation,
      input.segment,
    );
    if (verdict.ok) {
      compatible.push(candidate);
      continue;
    }
    if (verdict.reason && verdict.reason !== "target_trace_missing") {
      conflict = verdict.reason;
    }
  }

  if (conflict) {
    return {
      segmentKey: input.segmentKey,
      classification: conflict,
      reasonCode: conflict,
      target: null,
    };
  }

  if (compatible.length === 0) {
    return {
      segmentKey: input.segmentKey,
      classification: "target_trace_missing",
      reasonCode: "no_langfuse_trace_for_registry_run",
      target: null,
    };
  }

  if (compatible.length > 1) {
    const traceIds = new Set(compatible.map((c) => c.traceId));
    if (traceIds.size > 1) {
      return {
        segmentKey: input.segmentKey,
        classification: "target_trace_ambiguous",
        reasonCode: "multiple_compatible_traces",
        target: null,
      };
    }
  }

  const match = compatible[0]!;
  if (!match.phase || !match.windowStart || !match.windowEnd) {
    return {
      segmentKey: input.segmentKey,
      classification: "target_trace_missing",
      reasonCode: "trace_metadata_incomplete",
      target: null,
    };
  }
  const target: ExactTraceTarget = {
    segmentKey: input.segmentKey,
    traceId: match.traceId,
    agentHash: input.matchedRunOperation.agentHash,
    linearIssueKey: match.issueKey,
    phase: match.phase,
    phaseExecutionId: match.phaseExecutionId,
    harnessRunId: match.harnessRunId,
    runHash: input.matchedRunOperation.runHash,
    windowStart: match.windowStart,
    windowEnd: match.windowEnd,
    canonicalModelId: match.model ? resolveCanonicalModelId(match.model) : null,
    variant: match.effectiveVariant ?? null,
  };

  return {
    segmentKey: input.segmentKey,
    classification: "exact_trace_match",
    reasonCode: null,
    target,
  };
}

export function mapAllHarnessOwnedTraces(input: {
  ownership: Array<{
    segmentKey: string;
    segment: UsageSegment;
    matchedRunOperation: RunOperationBinding | null;
    classification: string;
  }>;
  segmentsByKey: Map<string, UsageSegment>;
  candidates: UsageCandidate[];
}): TraceMappingResult[] {
  const results: TraceMappingResult[] = [];
  for (const row of input.ownership) {
    if (row.classification !== "harness_owned" || !row.matchedRunOperation) {
      continue;
    }
    const segment = input.segmentsByKey.get(row.segmentKey) ?? row.segment;
    results.push(
      mapHarnessOwnedSegmentToTrace({
        segmentKey: row.segmentKey,
        segment,
        matchedRunOperation: row.matchedRunOperation,
        candidates: input.candidates,
      }),
    );
  }
  return results;
}
