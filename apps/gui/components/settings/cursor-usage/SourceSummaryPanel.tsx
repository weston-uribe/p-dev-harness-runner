"use client";

import type { CursorUsageInspectResponse } from "@/lib/cursor-usage-client";

interface SourceSummaryPanelProps {
  inspection: CursorUsageInspectResponse | null;
}

export function SourceSummaryPanel({ inspection }: SourceSummaryPanelProps) {
  if (!inspection) return null;

  const totals = inspection.tokenBucketTotals;
  const nonzero = inspection.tokenBucketNonzeroCounts;

  return (
    <div
      className="rounded-md border p-4 text-sm"
      data-testid="cursor-usage-source-summary"
    >
      <h3 className="font-medium">Current file summary</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Separate from workspace-wide historical analytics below.
      </p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Total rows</dt>
          <dd data-testid="cursor-usage-source-row-count">
            {inspection.sourceRowCount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cloud Agent (attributable)</dt>
          <dd data-testid="cursor-usage-attributable-count">
            {inspection.cloudAgentAttributableRowCount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Non-Cloud Agent (excluded)</dt>
          <dd data-testid="cursor-usage-excluded-count">
            {inspection.nonCloudAgentExcludedRowCount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">No-token events</dt>
          <dd data-testid="cursor-usage-no-token-count">
            {inspection.nonCloudAgentNoTokenEventCount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invalid nonblank agent IDs</dt>
          <dd data-testid="cursor-usage-invalid-id-count">
            {inspection.invalidNonblankAgentIdCount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sort order</dt>
          <dd data-testid="cursor-usage-sort-order">{inspection.sortOrder}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Input tokens (nonzero rows)</dt>
          <dd data-testid="cursor-usage-cache-input-summary">
            {totals.inputTokens} ({nonzero.inputTokens})
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cache write</dt>
          <dd data-testid="cursor-usage-cache-write-summary">
            {totals.cacheWriteTokens} ({nonzero.cacheWriteTokens})
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cache read</dt>
          <dd data-testid="cursor-usage-cache-read-summary">
            {totals.cacheReadTokens} ({nonzero.cacheReadTokens})
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Output tokens</dt>
          <dd>{totals.outputTokens}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total tokens</dt>
          <dd>{totals.totalTokens}</dd>
        </div>
      </dl>
    </div>
  );
}
