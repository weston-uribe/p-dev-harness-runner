import { NextResponse } from "next/server";
import { previewLinearSetupRemote } from "@/lib/setup-server";
import type { LinearSetupPlanInput } from "@harness/setup/linear-setup-apply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Omit<
      LinearSetupPlanInput,
      "linearApiKey"
    > & { linearApiKey?: string };
    const preview = await previewLinearSetupRemote(payload);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Linear setup preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
