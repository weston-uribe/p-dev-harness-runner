"use client";

import type { PublicPreflightRow } from "@/lib/cursor-usage-client";

interface PreflightTableProps {
  rows: PublicPreflightRow[];
  sourceScopeComplete?: boolean;
  sourceScopeIncompleteReason?: string | null;
  uploadScopedRejectionCount?: number;
  agentScopedRejectionCount?: number;
  rejectionReasonCodes?: string[];
  conflicts?: string[];
  discoveryDiagnostics?: Record<string, unknown> | null;
  bundleCount?: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function PreflightTable({
  rows,
  sourceScopeComplete,
  sourceScopeIncompleteReason,
  uploadScopedRejectionCount = 0,
  agentScopedRejectionCount = 0,
  rejectionReasonCodes = [],
  conflicts = [],
  discoveryDiagnostics = null,
  bundleCount = 0,
}: PreflightTableProps) {
  const hasConflictRow = rows.some((r) => r.state === "conflict");
  const modelConflict =
    hasConflictRow ||
    conflicts.length > 0 ||
    rows.some((r) =>
      /model|variant|observed|source_not_in_observed/i.test(r.reason ?? ""),
    ) ||
    /model|variant/i.test(sourceScopeIncompleteReason ?? "");

  const matched = rows.filter((r) => r.state === "matched").length;
  const unresolved = rows.filter((r) => r.state === "unresolved").length;
  const conflictRows = rows.filter((r) => r.state === "conflict").length;

  return (
    <div className="space-y-3" data-testid="cursor-usage-preflight-panel">
      {discoveryDiagnostics ? (
        <div
          className="rounded-md border px-3 py-2 text-sm space-y-1"
          data-testid="cursor-usage-discovery-diagnostics"
        >
          <p>
            Traces retrieved:{" "}
            <span data-testid="diag-traces-fetched">
              {num(discoveryDiagnostics.tracesFetched) ?? "—"}
            </span>
          </p>
          <p>
            Viable candidates:{" "}
            <span data-testid="diag-viable-candidates">
              {num(discoveryDiagnostics.viableCandidateCount) ?? "—"}
            </span>
          </p>
          <p>
            Distinct CSV agents:{" "}
            <span data-testid="diag-csv-agents">
              {num(discoveryDiagnostics.distinctCsvAgentCount) ?? "—"}
            </span>
          </p>
          <p>
            Distinct candidate agents:{" "}
            <span data-testid="diag-candidate-agents">
              {num(discoveryDiagnostics.distinctCandidateAgentCount) ?? "—"}
            </span>
          </p>
          <p>
            Overlap:{" "}
            <span data-testid="diag-overlap">
              {num(discoveryDiagnostics.csvCandidateOverlapCount) ?? "—"}
            </span>
          </p>
          <p>
            Segments matched/unmatched/conflict: {matched}/{unresolved}/
            {conflictRows}
          </p>
          <p>
            Bundles proposed:{" "}
            <span data-testid="diag-bundles">{bundleCount}</span>
          </p>
        </div>
      ) : null}

      {sourceScopeComplete === false ? (
        <p
          className="text-sm text-amber-800 dark:text-amber-200"
          data-testid="cursor-usage-source-incomplete"
        >
          Source scope incomplete
          {sourceScopeIncompleteReason
            ? `: ${sourceScopeIncompleteReason}`
            : "."}{" "}
          Apply is disabled until every CSV row is deterministically accounted
          for.
        </p>
      ) : null}

      {modelConflict ? (
        <p
          className="text-sm font-medium text-amber-900 dark:text-amber-100"
          data-testid="cursor-usage-model-conflict-copy"
          role="status"
        >
          Model or variant conflict makes source scope incomplete and Apply is
          disabled.
        </p>
      ) : null}

      {(uploadScopedRejectionCount > 0 || agentScopedRejectionCount > 0) && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="cursor-usage-rejection-summary"
        >
          Rejections — upload-scoped: {uploadScopedRejectionCount}, agent-scoped:{" "}
          {agentScopedRejectionCount}
          {rejectionReasonCodes.length > 0
            ? ` (${rejectionReasonCodes.join(", ")})`
            : ""}
          . Raw cell contents are never shown.
        </p>
      )}

      {rows.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="cursor-usage-preflight-empty"
        >
          No attribution rows produced.
        </p>
      ) : (
        <div
          className="overflow-x-auto rounded-md border"
          data-testid="cursor-usage-preflight-table"
        >
          <table className="min-w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Agent hash</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Phase</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.publicRowId || `${row.cloudAgentIdHash}-${row.phase ?? "none"}-${row.reason ?? ""}`}
                  className="border-t"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.cloudAgentIdHash}
                  </td>
                  <td
                    className="px-3 py-2"
                    data-testid={`preflight-state-${row.state}`}
                  >
                    {row.state}
                  </td>
                  <td className="px-3 py-2">{row.phase ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.reason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
