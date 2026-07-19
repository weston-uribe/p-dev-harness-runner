import { NextResponse } from "next/server";
import { applyLinearWorkspaceRemote } from "@/lib/setup-server";
import type { LinearWorkspacePlanInput } from "@harness/setup/linear-workspace-apply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      plan: Omit<LinearWorkspacePlanInput, "linearApiKey"> & {
        linearApiKey?: string;
      };
      confirmed: boolean;
      fingerprint?: string;
    };
    const result = await applyLinearWorkspaceRemote(body);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Linear workspace apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
