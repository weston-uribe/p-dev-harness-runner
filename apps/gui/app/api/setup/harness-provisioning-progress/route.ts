import { NextResponse } from "next/server";
import { loadHarnessProvisioningDiagnosticRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

/**
 * Read-only redacted provisioning diagnostics for Step 1 progress polling.
 * Never returns tokens, environment values, or file contents.
 */
export async function GET() {
  try {
    const report = await loadHarnessProvisioningDiagnosticRemote();
    return NextResponse.json(report);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Harness provisioning progress diagnostic failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
