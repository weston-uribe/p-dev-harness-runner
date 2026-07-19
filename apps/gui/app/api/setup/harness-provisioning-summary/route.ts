import { NextResponse } from "next/server";
import { loadHarnessRepoProvisioningSummaryRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await loadHarnessRepoProvisioningSummaryRemote();
    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Harness repo provisioning summary failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
