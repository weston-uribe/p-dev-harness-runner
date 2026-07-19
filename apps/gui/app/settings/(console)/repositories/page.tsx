import { RepositoriesSettingsEditor } from "@/components/settings/editors/repositories-settings-editor";
import { loadRepositoriesEditorData } from "@/lib/settings/load-settings-editor-data";
import { loadRepositoriesOverview } from "@/lib/settings/load-repositories-overview";

export const dynamic = "force-dynamic";

export default async function SettingsRepositoriesPage() {
  const [data, overview] = await Promise.all([
    loadRepositoriesEditorData(),
    loadRepositoriesOverview(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Target repositories</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add, connect, verify, edit branches, and detach repositories that PDev may
          modify.
        </p>
      </div>
      <RepositoriesSettingsEditor
        initialConfigForm={data.configForm}
        initialConfigFingerprint={data.configFingerprint}
        initialOverview={overview}
      />
    </div>
  );
}
