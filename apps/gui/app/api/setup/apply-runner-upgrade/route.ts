import { NextResponse } from "next/server";
import { applyRunnerUpgradeForGui } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      confirmed?: boolean;
      previewFingerprint?: string;
      resume?: boolean;
    };

    if (body.confirmed !== true) {
      return NextResponse.json(
        { error: "Confirmed apply is required." },
        { status: 400 },
      );
    }

    const result = await applyRunnerUpgradeForGui({
      confirmed: true,
      previewFingerprint: body.previewFingerprint,
      resume: body.resume === true,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Runner upgrade apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
