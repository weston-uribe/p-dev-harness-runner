import { NextResponse } from "next/server";
import { previewLocalFiles } from "@/lib/setup-server";
import type { LocalSetupFormPayload } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as LocalSetupFormPayload;
    const preview = await previewLocalFiles(payload);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
