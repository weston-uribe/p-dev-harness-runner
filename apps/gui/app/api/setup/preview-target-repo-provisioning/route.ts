import { NextResponse } from "next/server";
import { previewTargetRepoProvisioningRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      owner?: string;
      name?: string;
      description?: string;
      visibility?: "private" | "public";
      operationId?: string;
      creationActionId?: string;
      createdAt?: string;
    };
    const preview = await previewTargetRepoProvisioningRemote({
      owner: body.owner ?? "",
      name: body.name ?? "",
      description: body.description,
      visibility: body.visibility,
      operationId: body.operationId,
      creationActionId: body.creationActionId,
      createdAt: body.createdAt,
    });
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Target repository provisioning preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
