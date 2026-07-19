import { NextResponse } from "next/server";
import { loadManualHarnessSecretCopyValues } from "@/lib/setup-server";
import { collectRemoteSecretInputs, redactKnownSecretValues } from "@harness/setup/redact-secrets";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      confirmedSensitiveReveal?: boolean;
    };

    if (body.confirmedSensitiveReveal !== true) {
      return NextResponse.json(
        {
          error:
            "Manual secret values require explicit confirmation that you understand they are sensitive.",
        },
        { status: 400 },
      );
    }

    const result = await loadManualHarnessSecretCopyValues();
    return NextResponse.json(result);
  } catch (error) {
    const knownSecrets = collectRemoteSecretInputs();
    const message = redactKnownSecretValues(
      error instanceof Error ? error.message : "Manual secret value generation failed",
      knownSecrets,
    );
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
