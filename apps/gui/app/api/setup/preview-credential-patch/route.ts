import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  previewCredentialPatch,
  type PatchableCredentialKey,
} from "@harness/setup/credential-patch";
import { toPublicApiError } from "@harness/gui/public-client-payload";

export const dynamic = "force-dynamic";

const ALLOWED = new Set<PatchableCredentialKey>([
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
]);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { key?: PatchableCredentialKey };
    if (!body.key || !ALLOWED.has(body.key)) {
      return NextResponse.json(
        { error: "A valid credential key is required." },
        { status: 400 },
      );
    }
    const preview = await previewCredentialPatch({
      cwd: resolveHarnessWorkspaceDir(),
      key: body.key,
    });
    return NextResponse.json(preview);
  } catch (error) {
    const publicError = toPublicApiError(error, {
      fallbackCode: "credential_preview_failed",
      fallbackMessage: "Credential preview failed.",
    });
    return NextResponse.json(
      { error: publicError.message, code: publicError.code },
      { status: 400 },
    );
  }
}
