import { NextResponse } from "next/server";
import { previewHarnessRepoProvisioningRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      operationId?: string;
    };
    const preview = await previewHarnessRepoProvisioningRemote({
      operationId: body.operationId,
    });
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Harness repo provisioning preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
