import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  applyCredentialPatch,
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
  let submittedValue = "";
  try {
    const body = (await request.json()) as {
      key?: PatchableCredentialKey;
      value?: string;
      expectedConfigFingerprint?: string;
    };

    if (!body.key || !ALLOWED.has(body.key)) {
      return NextResponse.json(
        { error: "A valid credential key is required." },
        { status: 400 },
      );
    }
    if (typeof body.value !== "string") {
      return NextResponse.json(
        { error: "A credential value is required." },
        { status: 400 },
      );
    }
    submittedValue = body.value;
    if (!body.expectedConfigFingerprint?.trim()) {
      return NextResponse.json(
        { error: "expectedConfigFingerprint is required." },
        { status: 400 },
      );
    }

    const result = await applyCredentialPatch({
      cwd: resolveHarnessWorkspaceDir(),
      patch: {
        key: body.key,
        value: body.value,
        expectedConfigFingerprint: body.expectedConfigFingerprint,
      },
    });

    // Never return saved token values.
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const publicError = toPublicApiError(error, {
      fallbackCode: "credential_patch_failed",
      fallbackMessage: "Credential patch failed.",
      knownSecrets: submittedValue ? [submittedValue] : [],
    });
    return NextResponse.json(
      { error: publicError.message, code: publicError.code },
      { status: 400 },
    );
  }
}
