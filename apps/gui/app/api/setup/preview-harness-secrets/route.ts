import { NextResponse } from "next/server";
import {
  previewHarnessSecretsRemote,
  type RemoteSecretFormPayload,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as RemoteSecretFormPayload;
    const preview = await previewHarnessSecretsRemote(payload);
    return NextResponse.json(preview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Harness secret preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
