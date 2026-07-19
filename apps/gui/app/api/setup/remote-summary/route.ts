import { NextResponse } from "next/server";
import { loadRemoteSetupSummary } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await loadRemoteSetupSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Remote summary failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
