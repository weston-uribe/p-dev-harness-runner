import { NextResponse } from "next/server";
import { previewConnectServicesRemote } from "@/lib/setup-server";
import type { LocalEnvFormInput } from "@harness/setup/local-apply-actions";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const env = (await request.json()) as LocalEnvFormInput;
    const preview = await previewConnectServicesRemote(env);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connect services preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
