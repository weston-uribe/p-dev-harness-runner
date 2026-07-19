import { NextResponse } from "next/server";
import { loadLinearSetupProgressRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await loadLinearSetupProgressRemote();
    return NextResponse.json(report);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Linear setup progress diagnostic failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
