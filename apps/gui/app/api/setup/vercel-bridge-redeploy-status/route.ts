import { NextResponse } from "next/server";
import { pollVercelBridgeRedeployRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      actionId?: string;
    };
    const result = await pollVercelBridgeRedeployRemote({
      actionId: body.actionId,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Vercel bridge redeploy status check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
