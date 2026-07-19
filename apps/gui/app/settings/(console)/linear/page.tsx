import { LinearSettingsEditor } from "@/components/settings/editors/linear-settings-editor";
import { loadLinearEditorData } from "@/lib/settings/load-settings-editor-data";

export const dynamic = "force-dynamic";

export default async function SettingsLinearPage() {
  const initialData = await loadLinearEditorData();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Linear</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage multiple Linear team and project associations for this harness.
        </p>
      </div>
      <LinearSettingsEditor initialData={initialData} />
    </div>
  );
}
