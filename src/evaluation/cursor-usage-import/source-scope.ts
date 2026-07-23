import type { ExportWindow, UsageSegment } from "./canonical.js";

/** Default source-coverage safety margin: exact containment (no expansion). */
export const DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS = 0;

export type SourceScopeIncompleteReason =
  | "export_window_unproven"
  | "export_window_missing"
  | "export_window_invalid"
  | "execution_outside_export_window"
  | "rejected_or_ambiguous_row_for_agent"
  | "upload_scoped_rejection"
  | "langfuse_retrieval_incomplete"
  | "langfuse_no_traces_in_window"
  | "langfuse_no_viable_candidates"
  | "langfuse_zero_agent_overlap"
  | "token_arithmetic_incomplete"
  | "unaccounted_source_segment"
  | "model_identity_conflict"
  | "variant_identity_conflict"
  | "pricing_incomplete"
  | null;

export interface SourceScopeVerdict {
  sourceScopeComplete: boolean;
  sourceScopeIncompleteReason: SourceScopeIncompleteReason;
}

function parseIso(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function validateExportWindow(
  window: ExportWindow | null | undefined,
): { ok: true; window: ExportWindow } | { ok: false; reason: SourceScopeIncompleteReason } {
  if (!window) {
    return { ok: false, reason: "export_window_missing" };
  }
  if (window.boundsSource === "unproven") {
    return { ok: false, reason: "export_window_unproven" };
  }
  const start = parseIso(window.startIso);
  const end = parseIso(window.endIso);
  if (start == null || end == null || end < start) {
    return { ok: false, reason: "export_window_invalid" };
  }
  return { ok: true, window };
}

/**
 * A trace bundle is source-scope complete only when the agent execution window
 * is contained in the export window (with optional safety margin), every segment
 * for that agent is accounted for, and no rejected/ambiguous row could belong
 * to the execution.
 *
 * Containment (margin default 0):
 *   exportStart <= executionStart - safetyMarginMs
 *   exportEnd   >= executionEnd   + safetyMarginMs
 *
 * Attribution ingestion slack must NOT be used here.
 */
export function evaluateSourceScope(params: {
  exportWindow: ExportWindow | null | undefined;
  executionWindowStartIso: string | null;
  executionWindowEndIso: string | null;
  agentSegments: UsageSegment[];
  accountedSegmentFingerprints: Set<string>;
  hasRejectedOrAmbiguousForAgent: boolean;
  hasUploadScopedRejection?: boolean;
  langfuseRetrievalComplete: boolean;
  tokenArithmeticComplete: boolean;
  /** Source-coverage safety margin in ms (default 0). Not attribution slack. */
  sourceCoverageSafetyMarginMs?: number;
}): SourceScopeVerdict {
  const validated = validateExportWindow(params.exportWindow);
  if (!validated.ok) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: validated.reason,
    };
  }

  if (params.hasUploadScopedRejection) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "upload_scoped_rejection",
    };
  }

  if (!params.tokenArithmeticComplete) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "token_arithmetic_incomplete",
    };
  }
  if (!params.langfuseRetrievalComplete) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "langfuse_retrieval_incomplete",
    };
  }
  if (params.hasRejectedOrAmbiguousForAgent) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "rejected_or_ambiguous_row_for_agent",
    };
  }

  const margin =
    params.sourceCoverageSafetyMarginMs ?? DEFAULT_SOURCE_COVERAGE_SAFETY_MARGIN_MS;
  const execStart = params.executionWindowStartIso
    ? parseIso(params.executionWindowStartIso)
    : null;
  const execEnd = params.executionWindowEndIso
    ? parseIso(params.executionWindowEndIso)
    : null;
  const exportStart = parseIso(validated.window.startIso)!;
  const exportEnd = parseIso(validated.window.endIso)!;

  if (execStart == null || execEnd == null) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "execution_outside_export_window",
    };
  }
  // exportStart <= execStart - margin  AND  exportEnd >= execEnd + margin
  if (exportStart > execStart - margin || exportEnd < execEnd + margin) {
    return {
      sourceScopeComplete: false,
      sourceScopeIncompleteReason: "execution_outside_export_window",
    };
  }

  for (const seg of params.agentSegments) {
    for (const fp of seg.fingerprints) {
      if (!params.accountedSegmentFingerprints.has(fp)) {
        return {
          sourceScopeComplete: false,
          sourceScopeIncompleteReason: "unaccounted_source_segment",
        };
      }
    }
  }

  return {
    sourceScopeComplete: true,
    sourceScopeIncompleteReason: null,
  };
}
