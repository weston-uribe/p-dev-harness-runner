import { NextResponse } from "next/server";
import { loadVercelSetupSummary } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await loadVercelSetupSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Vercel summary failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
