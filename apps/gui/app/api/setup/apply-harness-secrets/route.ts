import { NextResponse } from "next/server";
import {
  applyHarnessSecretsRemote,
  type RemoteSecretFormPayload,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RemoteSecretFormPayload & {
      confirmed?: boolean;
      fingerprint?: string;
    };

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
    const result = await applyHarnessSecretsRemote({
      payload,
      confirmed: confirmed === true,
      fingerprint,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Harness secret apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
