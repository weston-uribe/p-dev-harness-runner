import { NextResponse } from "next/server";
import { previewRunnerUpgradeForGui } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const preview = await previewRunnerUpgradeForGui();
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Runner upgrade preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
