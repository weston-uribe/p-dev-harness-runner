import { NextResponse } from "next/server";
import {
  previewTargetWorkflowRemote,
  type RemoteTargetWorkflowFormPayload,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as RemoteTargetWorkflowFormPayload;
    if (!payload.repoConfigId || !payload.targetRepo || !payload.productionBranch) {
      return NextResponse.json(
        { error: "repoConfigId, targetRepo, and productionBranch are required" },
        { status: 400 },
      );
    }
    const preview = await previewTargetWorkflowRemote(payload);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Target workflow preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
