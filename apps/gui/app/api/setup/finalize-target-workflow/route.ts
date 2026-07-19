import { NextResponse } from "next/server";
import {
  finalizeTargetWorkflowRemoteAction,
  type RemoteTargetWorkflowFormPayload,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RemoteTargetWorkflowFormPayload & {
      prUrl?: string;
      branchName?: string;
    };

    if (!body.repoConfigId || !body.targetRepo || !body.productionBranch) {
      return NextResponse.json(
        { error: "repoConfigId, targetRepo, and productionBranch are required" },
        { status: 400 },
      );
    }

    const result = await finalizeTargetWorkflowRemoteAction(body);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Target workflow finalization failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
