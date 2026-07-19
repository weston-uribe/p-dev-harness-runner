import { NextResponse } from "next/server";
import { loadLinearWorkspaceOptions } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const options = await loadLinearWorkspaceOptions();
    return NextResponse.json(options);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Linear workspace options";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
