import { AppShell } from "@/components/custom/app-shell";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Route-level shell for Settings while layout/page data resolves.
 * Left nav renders immediately; page cards stream in afterward.
 */
export default function SettingsConsoleLoading() {
  return (
    <AppShell settingsHref="/settings" isSettingsActive>
      <SettingsShell>
        <div className="space-y-4" aria-busy="true" aria-label="Loading settings">
          <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-96 max-w-full animate-pulse rounded-md bg-muted" />
          <div className="mt-6 space-y-3">
            <div className="h-24 animate-pulse rounded-md border border-border bg-muted/40" />
            <div className="h-40 animate-pulse rounded-md border border-border bg-muted/40" />
          </div>
        </div>
      </SettingsShell>
    </AppShell>
  );
}
