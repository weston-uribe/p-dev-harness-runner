import { NextResponse } from "next/server";
import { applyLocalFiles } from "@/lib/setup-server";
import type { LocalSetupFormPayload } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

interface ApplyRequestBody extends LocalSetupFormPayload {
  confirmed: boolean;
  fingerprint: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ApplyRequestBody;
    const { confirmed, fingerprint, env, config } = body;

    if (!confirmed) {
      return NextResponse.json(
        { error: "Local file writes require explicit confirmation" },
        { status: 400 },
      );
    }

    if (!fingerprint) {
      return NextResponse.json(
        { error: "Preview fingerprint is required" },
        { status: 400 },
      );
    }

    const result = await applyLocalFiles({
      payload: { env, config },
      confirmed,
      fingerprint,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Apply failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
