import { NextResponse } from "next/server";
import { previewVercelBridgeRemote } from "@/lib/setup-server";
import type { VercelBridgePlanInput } from "@harness/setup/vercel-setup-apply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Omit<
      VercelBridgePlanInput,
      "vercelToken" | "linearApiKey"
    > & {
      vercelToken?: string;
      linearApiKey?: string;
    };
    const preview = await previewVercelBridgeRemote(payload);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Vercel bridge preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
