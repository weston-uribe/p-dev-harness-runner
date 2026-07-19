import { NextResponse } from "next/server";
import {
  applyTargetWorkflowRemote,
  type RemoteTargetWorkflowFormPayload,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RemoteTargetWorkflowFormPayload & {
      confirmed?: boolean;
      fingerprint?: string;
    };

    if (!body.repoConfigId || !body.targetRepo || !body.productionBranch) {
      return NextResponse.json(
        { error: "repoConfigId, targetRepo, and productionBranch are required" },
        { status: 400 },
      );
    }

    if (!body.confirmed) {
      return NextResponse.json(
        { error: "Remote setup writes require explicit confirmation" },
        { status: 400 },
      );
    }

    if (!body.fingerprint) {
      return NextResponse.json(
        { error: "Preview fingerprint is required" },
        { status: 400 },
      );
    }

    const { confirmed, fingerprint, ...payload } = body;
    const result = await applyTargetWorkflowRemote({
      payload,
      confirmed: confirmed === true,
      fingerprint,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Target workflow apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
