import { SettingsModelsClient } from "@/components/settings/settings-models-client";
import { loadWorkflowBootstrap } from "@/lib/workflow-server";

export const dynamic = "force-dynamic";

export default async function SettingsModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; fixture?: string; scope?: string }>;
}) {
  const params = await searchParams;
  // Fixture query params keep Settings Models aligned with Workflow fixture saves
  // for local browser acceptance (same in-memory roleModels store).
  const bootstrap = await loadWorkflowBootstrap({
    source: params.source ?? null,
    fixture: params.fixture ?? null,
    scope: params.scope ?? null,
  });

  return <SettingsModelsClient initialBootstrap={bootstrap} />;
}
