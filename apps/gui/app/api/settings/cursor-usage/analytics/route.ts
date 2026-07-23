import { NextRequest, NextResponse } from "next/server";
import { guardCursorUsageGet } from "@/lib/cursor-usage-request-guard";
import { readImportAnalytics } from "@/lib/cursor-usage-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageGet(request);
  if (!guard.ok) {
    return guard.response;
  }

  const analytics = await readImportAnalytics();
  return NextResponse.json(analytics);
}
