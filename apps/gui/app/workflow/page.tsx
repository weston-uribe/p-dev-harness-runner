import { AppShell } from "@/components/custom/app-shell";
import { AutomationHealthFacts } from "@/components/settings/automation-health-facts";
import { VercelConnectionWarning } from "@/components/workflow/vercel-connection-warning";
import { WorkflowPageClient } from "@/components/workflow/workflow-page-client";
import { loadWorkflowBootstrap } from "@/lib/workflow-server";
import { loadWorkspaceHealthSnapshot } from "@/lib/workspace-health-server";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; fixture?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const [bootstrap, workspaceHealth] = await Promise.all([
    loadWorkflowBootstrap({
      source: params.source ?? null,
      fixture: params.fixture ?? null,
      scope: params.scope ?? null,
    }),
    loadWorkspaceHealthSnapshot(),
  ]);

  return (
    <AppShell isWorkflowActive>
      <div className="mb-4 empty:hidden">
        <AutomationHealthFacts snapshot={workspaceHealth} />
      </div>
      <VercelConnectionWarning
        durableBridgeVerified={
          workspaceHealth.vercel.durableBridgeHealth === "verified"
        }
        controlPlaneFingerprint={workspaceHealth.controlPlaneFingerprint}
      />
      <WorkflowPageClient initialBootstrap={bootstrap} />
    </AppShell>
  );
}
