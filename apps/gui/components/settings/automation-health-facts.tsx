import {
  deriveAutomationAttentionState,
  type WorkspaceHealthSnapshot,
} from "@harness/setup/workspace-health-snapshot";
import type { HealthAggregateStatus } from "@harness/setup/workspace-health";

function toneClass(status: Exclude<HealthAggregateStatus, "verified">): string {
  if (status === "degraded" || status === "repairing") {
    return "border-amber-500/40 bg-amber-500/5";
  }
  return "border-border bg-muted/30";
}

function subsystemLabel(subsystem: "vercel" | "linear"): string {
  return subsystem === "vercel" ? "Vercel" : "Linear";
}

/**
 * Attention-only automation panel shared by Workflow and Connections.
 * Renders nothing when both Linear and Vercel automation are verified.
 */
export function AutomationHealthFacts({
  snapshot,
}: {
  snapshot: WorkspaceHealthSnapshot;
}) {
  const attention = deriveAutomationAttentionState(snapshot);
  if (!attention) {
    return null;
  }

  return (
    <section
      aria-label="Automation health"
      className={`rounded-md border p-3 text-sm ${toneClass(attention.tone)}`}
    >
      <p className="font-medium">{attention.title}</p>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {attention.facts.map((fact) => (
          <li key={fact.subsystem}>
            {subsystemLabel(fact.subsystem)}: {fact.detail}
          </li>
        ))}
      </ul>
      {snapshot.vercel.historicalSetupComplete &&
      !snapshot.vercel.webhookVerified &&
      attention.facts.some((fact) => fact.subsystem === "vercel") ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          A prior successful setup does not override missing current webhook
          verification.
        </p>
      ) : null}
    </section>
  );
}
