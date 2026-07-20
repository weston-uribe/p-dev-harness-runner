/**
 * Route-content skeleton while a Settings page resolves.
 * The parent layout owns the persistent product and settings chrome.
 */
export default function SettingsConsoleLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading settings">
      <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded-md bg-muted" />
      <div className="mt-6 space-y-3">
        <div className="h-24 animate-pulse rounded-md border border-border bg-muted/40" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    </div>
  );
}
