"use client";

import type { AnalyticsResponse } from "@/lib/cursor-usage-client";

interface AnalyticsPanelProps {
  analytics: AnalyticsResponse | null;
}

const LOCAL_LABELS: Record<
  AnalyticsResponse["localEvidenceCompleteness"],
  string
> = {
  complete: "Complete (verified local ledgers)",
  partial: "Partial",
  none: "None",
};

const LANGFUSE_LABELS: Record<
  AnalyticsResponse["langfuseReconciliationStatus"],
  string
> = {
  not_run: "Not run",
  unavailable: "Unavailable",
  complete: "Complete",
  divergent: "Divergent",
};

function GroupTable(props: {
  title: string;
  testId: string;
  rows: Record<
    string,
    {
      bundles: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  >;
}) {
  const entries = Object.entries(props.rows);
  if (entries.length === 0) return null;
  return (
    <div className="mt-4" data-testid={props.testId}>
      <h4 className="font-medium">{props.title}</h4>
      <table className="mt-2 w-full text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 pr-2">Key</th>
            <th className="py-1 pr-2">Bundles</th>
            <th className="py-1 pr-2">Input tokens</th>
            <th className="py-1 pr-2">Output tokens</th>
            <th className="py-1">Total tokens</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, row]) => (
            <tr key={key} data-testid={`${props.testId}-row`}>
              <td className="py-1 pr-2 font-mono">{key}</td>
              <td className="py-1 pr-2">{row.bundles}</td>
              <td className="py-1 pr-2">{row.inputTokens ?? 0}</td>
              <td className="py-1 pr-2">{row.outputTokens ?? 0}</td>
              <td className="py-1">{row.totalTokens ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalyticsPanel({ analytics }: AnalyticsPanelProps) {
  if (!analytics) {
    return null;
  }

  const grouped = analytics.grouped;

  return (
    <div
      className="rounded-md border p-4 text-sm"
      data-testid="cursor-usage-analytics-panel"
    >
      <h3 className="font-medium">Analytics</h3>
      <p className="mt-2 text-muted-foreground">
        Totals cover only ledgers in the current operator workspace.
      </p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Local evidence</dt>
          <dd data-testid="cursor-usage-analytics-local-evidence">
            {LOCAL_LABELS[analytics.localEvidenceCompleteness]}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Langfuse reconciliation</dt>
          <dd data-testid="cursor-usage-analytics-langfuse-status">
            {LANGFUSE_LABELS[analytics.langfuseReconciliationStatus]}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Imports</dt>
          <dd>{analytics.ledgerCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Verified imports</dt>
          <dd>{analytics.verifiedCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Incomplete imports</dt>
          <dd>{analytics.incompleteCount ?? 0}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total bundles</dt>
          <dd>{analytics.totalBundles}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total scores</dt>
          <dd>{analytics.totalScores}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Unresolved segments</dt>
          <dd data-testid="cursor-usage-analytics-unresolved">
            {analytics.unresolvedSegmentCount ?? 0}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pricing-incomplete segments</dt>
          <dd data-testid="cursor-usage-analytics-pricing-incomplete">
            {analytics.pricingIncompleteSegmentCount ?? 0}
          </dd>
        </div>
      </dl>

      {grouped ? (
        <div data-testid="cursor-usage-analytics-grouped">
          <GroupTable
            title="By issue"
            testId="cursor-usage-analytics-by-issue"
            rows={grouped.byIssue ?? {}}
          />
          <GroupTable
            title="By phase"
            testId="cursor-usage-analytics-by-phase"
            rows={grouped.byPhase ?? {}}
          />
          <GroupTable
            title="By source model"
            testId="cursor-usage-analytics-by-source-model"
            rows={grouped.bySourceModel ?? {}}
          />
          <GroupTable
            title="By canonical model"
            testId="cursor-usage-analytics-by-canonical-model"
            rows={grouped.byCanonicalModel ?? {}}
          />
          <GroupTable
            title="By variant"
            testId="cursor-usage-analytics-by-variant"
            rows={grouped.byEffectiveVariant ?? {}}
          />
          <GroupTable
            title="By source digest"
            testId="cursor-usage-analytics-by-source-digest"
            rows={grouped.bySourceDigest ?? {}}
          />
          <GroupTable
            title="By pricing registry"
            testId="cursor-usage-analytics-by-pricing-registry"
            rows={grouped.byPricingRegistryVersion ?? {}}
          />
        </div>
      ) : null}
    </div>
  );
}
