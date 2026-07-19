import { NextResponse } from "next/server";
import { applyLinearSetupRemote } from "@/lib/setup-server";
import type { LinearSetupPlanInput } from "@harness/setup/linear-setup-apply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      plan: Omit<LinearSetupPlanInput, "linearApiKey"> & {
        linearApiKey?: string;
      };
      confirmed: boolean;
      fingerprint: string;
    };
    const result = await applyLinearSetupRemote(body);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Linear setup apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
