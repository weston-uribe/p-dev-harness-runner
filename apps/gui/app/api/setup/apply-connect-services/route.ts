import { NextResponse } from "next/server";
import { applyConnectServicesRemote } from "@/lib/setup-server";
import type { LocalEnvFormInput } from "@harness/setup/local-apply-actions";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      env: LocalEnvFormInput;
      confirmed: boolean;
      fingerprint: string;
    };
    const result = await applyConnectServicesRemote(body);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connect services apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
