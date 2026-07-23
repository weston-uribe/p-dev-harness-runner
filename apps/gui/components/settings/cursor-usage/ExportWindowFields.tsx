"use client";

interface ExportWindowFieldsProps {
  exportStart: string;
  exportEnd: string;
  timezone: string;
  timezoneEvidence: string | null;
  sortOrder: string | null;
  advancedOverride: boolean;
  assumedTimezone: string;
  disabled?: boolean;
  onExportStartChange: (value: string) => void;
  onExportEndChange: (value: string) => void;
  onTimezoneChange: (value: string) => void;
  onAdvancedOverrideChange: (value: boolean) => void;
  onAssumedTimezoneChange: (value: string) => void;
}

export function ExportWindowFields({
  exportStart,
  exportEnd,
  timezone,
  timezoneEvidence,
  sortOrder,
  advancedOverride,
  assumedTimezone,
  disabled = false,
  onExportStartChange,
  onExportEndChange,
  onTimezoneChange,
  onAdvancedOverrideChange,
  onAssumedTimezoneChange,
}: ExportWindowFieldsProps) {
  return (
    <div className="space-y-3" data-testid="cursor-usage-export-window">
      <fieldset className="grid gap-4 rounded-md border p-4 sm:grid-cols-3">
        <legend className="px-1 text-sm font-medium">Observed event window</legend>
        <label className="grid gap-1 text-sm">
          <span>Observed start (UTC)</span>
          <input
            type="text"
            className="h-9 rounded-md border bg-background px-3"
            value={exportStart}
            disabled={disabled || !advancedOverride}
            readOnly={!advancedOverride}
            placeholder="Auto from CSV min timestamp"
            data-testid="cursor-usage-export-start"
            onChange={(event) => onExportStartChange(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Observed end (UTC)</span>
          <input
            type="text"
            className="h-9 rounded-md border bg-background px-3"
            value={exportEnd}
            disabled={disabled || !advancedOverride}
            readOnly={!advancedOverride}
            placeholder="Auto from CSV max timestamp"
            data-testid="cursor-usage-export-end"
            onChange={(event) => onExportEndChange(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Timezone evidence</span>
          <input
            type="text"
            className="h-9 rounded-md border bg-background px-3"
            value={timezone}
            disabled={disabled || !advancedOverride}
            readOnly={!advancedOverride}
            data-testid="cursor-usage-export-timezone"
            onChange={(event) => onTimezoneChange(event.target.value)}
          />
        </label>
        {timezoneEvidence ? (
          <p
            className="sm:col-span-3 text-xs text-muted-foreground"
            data-testid="cursor-usage-timezone-evidence"
          >
            Evidence: {timezoneEvidence}
            {sortOrder ? ` · File sort: ${sortOrder}` : ""}
          </p>
        ) : null}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={advancedOverride}
          disabled={disabled}
          data-testid="cursor-usage-advanced-override"
          onChange={(event) => onAdvancedOverrideChange(event.target.checked)}
        />
        <span>Advanced: manual observed-window override</span>
      </label>

      {(advancedOverride || timezoneEvidence === "unproven") && (
        <label className="grid max-w-md gap-1 text-sm">
          <span>Assumed IANA timezone (offset-free timestamps only)</span>
          <input
            type="text"
            className="h-9 rounded-md border bg-background px-3"
            value={assumedTimezone}
            disabled={disabled}
            placeholder="America/Los_Angeles"
            data-testid="cursor-usage-assumed-timezone"
            onChange={(event) => onAssumedTimezoneChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}
