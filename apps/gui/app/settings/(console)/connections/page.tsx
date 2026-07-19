import { ConnectionsSettingsEditor } from "@/components/settings/editors/connections-settings-editor";
import { loadConnectionsEditorData } from "@/lib/settings/load-settings-editor-data";

export const dynamic = "force-dynamic";

export default async function SettingsConnectionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ repair?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const repairVercel = params.repair === "vercel";
  const data = await loadConnectionsEditorData();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Connections</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replace credentials with verify-before-commit. Values are never shown
          after save.
        </p>
      </div>
      <ConnectionsSettingsEditor
        initialPresence={data.presence}
        initialServiceConnectionSummaries={data.serviceConnectionSummaries}
        envDefaults={{
          harnessConfigPath: data.envDefaults.harnessConfigPath,
          githubDispatchRepository: data.envDefaults.githubDispatchRepository,
        }}
        repairVercel={repairVercel}
        envContentFingerprint={data.envContentFingerprint}
      />
    </div>
  );
}
