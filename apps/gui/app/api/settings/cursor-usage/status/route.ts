import { NextRequest, NextResponse } from "next/server";
import { guardCursorUsageGet } from "@/lib/cursor-usage-request-guard";
import { readImportStatus } from "@/lib/cursor-usage-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageGet(request);
  if (!guard.ok) {
    return guard.response;
  }

  const importId = request.nextUrl.searchParams.get("importId")?.trim() ?? "";
  if (!importId) {
    return NextResponse.json({ error: "importId is required." }, { status: 400 });
  }

  const status = await readImportStatus(importId);
  if (!status) {
    return NextResponse.json({ error: "Import not found." }, { status: 404 });
  }

  return NextResponse.json(status);
}
