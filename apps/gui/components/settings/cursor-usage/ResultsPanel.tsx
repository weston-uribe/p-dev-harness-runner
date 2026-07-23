"use client";

import type { ImportStatusResponse } from "@/lib/cursor-usage-client";

interface ResultsPanelProps {
  status: ImportStatusResponse | null;
  publicSummary: Record<string, unknown> | null;
}

export function ResultsPanel({ status, publicSummary }: ResultsPanelProps) {
  if (!status && !publicSummary) {
    return null;
  }

  return (
    <div
      className="rounded-md border p-4 text-sm"
      data-testid="cursor-usage-results-panel"
    >
      <h3 className="font-medium">Import status</h3>
      {status ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Lifecycle</dt>
            <dd data-testid="cursor-usage-lifecycle">{status.lifecycle}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Verified</dt>
            <dd data-testid="cursor-usage-verified">
              {status.verified ? "yes" : "no"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Bundles</dt>
            <dd>{status.bundleCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Source scope complete</dt>
            <dd>{status.sourceScopeComplete ? "yes" : "no"}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
