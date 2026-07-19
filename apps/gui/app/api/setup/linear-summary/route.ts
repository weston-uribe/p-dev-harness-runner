import { NextResponse } from "next/server";
import { loadLinearSetupSummary } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await loadLinearSetupSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Linear summary failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
