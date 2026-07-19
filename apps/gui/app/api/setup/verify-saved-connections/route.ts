import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  CREDENTIAL_HEALTH_KEYS,
  verifyAllSavedCredentialHealth,
  verifySavedCredentialHealth,
} from "@harness/setup/credential-health";
import { toPublicApiError } from "@harness/gui/public-client-payload";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      key?: (typeof CREDENTIAL_HEALTH_KEYS)[number];
    };
    const cwd = resolveHarnessWorkspaceDir();

    if (body.key) {
      if (!(CREDENTIAL_HEALTH_KEYS as readonly string[]).includes(body.key)) {
        return NextResponse.json(
          { error: "A valid credential key is required." },
          { status: 400 },
        );
      }
      const health = await verifySavedCredentialHealth({ cwd, key: body.key });
      // Never return saved token values — only typed health.
      return NextResponse.json({ key: body.key, health });
    }

    const health = await verifyAllSavedCredentialHealth({ cwd });
    return NextResponse.json({ health });
  } catch (error) {
    const publicError = toPublicApiError(error, {
      fallbackCode: "saved_connection_verify_failed",
      fallbackMessage: "Saved connection verification failed.",
    });
    return NextResponse.json(
      { error: publicError.message, code: publicError.code },
      { status: 400 },
    );
  }
}
