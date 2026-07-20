import type { WorkspaceHealthSnapshot } from "@harness/setup/workspace-health-snapshot";
import type { HealthAggregateStatus } from "@harness/setup/workspace-health";

function aggregateLabel(status: HealthAggregateStatus): string {
  switch (status) {
    case "missing":
      return "Missing";
    case "configured":
      return "Configured";
    case "verification_pending":
      return "Verification pending";
    case "verified":
      return "Verified";
    case "degraded":
      return "Degraded";
    case "repairing":
      return "Repairing";
  }
}

function toneClass(status: HealthAggregateStatus): string {
  if (status === "verified") {
    return "border-emerald-500/40 bg-emerald-500/5";
  }
  if (status === "degraded" || status === "repairing") {
    return "border-amber-500/40 bg-amber-500/5";
  }
  if (status === "verification_pending") {
    return "border-border bg-muted/30";
  }
  return "border-border";
}

/** Shared fact strip — never shows a green check for verification_pending. */
export function AutomationHealthFacts({
  snapshot,
}: {
  snapshot: WorkspaceHealthSnapshot;
}) {
  const { vercel, linear } = snapshot;
  const showVerifiedMark = vercel.automationAggregate === "verified";

  return (
    <section
      aria-label="Automation health"
      className={`rounded-md border p-3 text-sm ${toneClass(vercel.automationAggregate)}`}
    >
      <p className="font-medium">
        Automation: {aggregateLabel(vercel.automationAggregate)}
        {showVerifiedMark ? " ✓" : ""}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        <li>
          Vercel credential: {aggregateLabel(vercel.credential.aggregate)}
          {vercel.selectedScope
            ? ` · scope ${vercel.selectedScope.teamName}`
            : ""}
          {vercel.selectedProject
            ? ` · ${vercel.selectedProject.projectName}`
            : ""}
        </li>
        <li>
          Bridge:{" "}
          {vercel.bridgeDeployed
            ? vercel.bridgeReachable
              ? "deployed, reachable"
              : "deployed, not reachable"
            : "not deployed"}
          {" · "}
          Webhook:{" "}
          {vercel.webhookVerified
            ? "verified"
            : vercel.webhookConfigured
              ? "configured, not verified"
              : "not configured"}
        </li>
        <li>
          Linear:{" "}
          {linear.workspaceName?.trim() || "workspace name unavailable"} ·{" "}
          {aggregateLabel(linear.automationAggregate)}
        </li>
      </ul>
      {vercel.historicalSetupComplete && !vercel.webhookVerified ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          A prior successful setup does not override missing current webhook
          verification.
        </p>
      ) : null}
    </section>
  );
}
