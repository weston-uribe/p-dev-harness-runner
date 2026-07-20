"use client";

import Link from "next/link";
import type { VercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import type { WorkspaceHealthSnapshot } from "@harness/setup/workspace-health-snapshot";

type DeploymentsSettingsEditorProps = {
  initialSummary: VercelSetupSummary;
  workspaceHealth?: WorkspaceHealthSnapshot;
};

export function DeploymentsSettingsEditor({
  initialSummary,
  workspaceHealth,
}: DeploymentsSettingsEditorProps) {
  const summary = initialSummary;
  const teamLabel =
    workspaceHealth?.vercel.selectedScope?.teamName ??
    summary.controlPlane?.vercel?.teamName ??
    (workspaceHealth?.vercel.selectedScope?.teamId ||
    summary.controlPlane?.vercel?.teamId
      ? "Team"
      : summary.controlPlane?.vercel?.projectId
        ? "Personal"
        : "Not configured");
  const projectLabel =
    workspaceHealth?.vercel.selectedProject?.projectName ??
    summary.controlPlane?.vercel?.projectName ??
    "Not configured";
  const productionUrl =
    workspaceHealth?.vercel.productionUrl ??
    summary.controlPlane?.vercel?.productionUrl ??
    "—";

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-border p-4 text-sm">
        <p>
          <span className="text-muted-foreground">Team:</span> {teamLabel}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Project:</span> {projectLabel}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Production URL:</span>{" "}
          {productionUrl}
        </p>
      </div>

      {!summary.vercelTokenConfigured ? (
        <p className="text-sm text-muted-foreground">
          Connect Vercel in{" "}
          <Link href="/settings/connections" className="underline">
            Settings → Connections
          </Link>{" "}
          to configure deployments.
        </p>
      ) : null}
    </div>
  );
}
