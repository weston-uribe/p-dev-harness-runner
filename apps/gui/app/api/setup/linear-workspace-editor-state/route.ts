import { NextResponse } from "next/server";
import { loadLinearWorkspaceEditorState } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await loadLinearWorkspaceEditorState();
    return NextResponse.json(state);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Linear workspace editor state";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
