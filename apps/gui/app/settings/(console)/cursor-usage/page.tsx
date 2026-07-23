import { P_DEV_OBSERVABILITY_NONCE_ENV } from "@harness/observability/constants.js";
import { CursorUsagePage } from "@/components/settings/cursor-usage/CursorUsagePage";

export const dynamic = "force-dynamic";

export default function CursorUsageSettingsPage() {
  const observabilityNonce =
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Cursor usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Bulk import official Cursor usage CSV exports into Langfuse phase trace
          scores. Private agent identifiers are never shown in the browser.
        </p>
      </div>
      <CursorUsagePage nonce={observabilityNonce} />
    </div>
  );
}
