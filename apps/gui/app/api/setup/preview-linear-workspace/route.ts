import { NextResponse } from "next/server";
import { previewLinearWorkspaceRemote } from "@/lib/setup-server";
import type { LinearWorkspacePlanInput } from "@harness/setup/linear-workspace-apply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Omit<
      LinearWorkspacePlanInput,
      "linearApiKey"
    > & {
      linearApiKey?: string;
    };
    const preview = await previewLinearWorkspaceRemote(body);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Linear workspace preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
