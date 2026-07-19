import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  previewSettingsConfigPatch,
  SettingsConfigPatchError,
  type SettingsConfigPatch,
} from "@harness/setup/settings-config-patch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      patch: SettingsConfigPatch;
      verifyBranches?: boolean;
      requireDistinctBranches?: boolean;
    };
    const preview = await previewSettingsConfigPatch({
      cwd: resolveHarnessWorkspaceDir(),
      patch: body.patch,
      verifyBranches: body.verifyBranches,
      requireDistinctBranches: body.requireDistinctBranches,
    });
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof SettingsConfigPatchError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Settings config preview failed.",
      },
      { status: 400 },
    );
  }
}
