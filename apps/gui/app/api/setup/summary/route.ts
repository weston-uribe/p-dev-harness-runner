import { NextResponse } from "next/server";

import { loadSetupSummary } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const summary = await loadSetupSummary();
  return NextResponse.json(summary);
}
