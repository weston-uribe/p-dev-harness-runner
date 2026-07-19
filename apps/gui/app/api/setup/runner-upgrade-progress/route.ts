import { NextResponse } from "next/server";
import { loadRunnerUpgradeProgressForGui } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const progress = await loadRunnerUpgradeProgressForGui();
    return NextResponse.json({ progress });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Runner upgrade progress read failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
