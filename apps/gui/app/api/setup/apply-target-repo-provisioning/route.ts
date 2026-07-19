import { NextResponse } from "next/server";
import { applyTargetRepoProvisioningRemote } from "@/lib/setup-server";

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
      fingerprint?: string;
      confirmed?: boolean;
    };
    const apply = await applyTargetRepoProvisioningRemote({
      owner: body.owner ?? "",
      name: body.name ?? "",
      description: body.description,
      visibility: body.visibility,
      operationId: body.operationId ?? "",
      creationActionId: body.creationActionId ?? "",
      createdAt: body.createdAt ?? "",
      fingerprint: body.fingerprint ?? "",
      confirmed: body.confirmed === true,
    });
    return NextResponse.json(apply);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Target repository provisioning apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
