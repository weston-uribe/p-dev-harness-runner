import { NextRequest, NextResponse } from "next/server";
import { guardCursorUsageJsonApply } from "@/lib/cursor-usage-request-guard";
import { runApplyCsvImport } from "@/lib/cursor-usage-server";
import { CursorUsageDiscoveryError } from "@harness/evaluation/cursor-usage-import/discovery-config.js";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageJsonApply(request);
  if (!guard.ok) {
    return guard.response;
  }

  const body = guard.body as Record<string, unknown>;
  const importId = String(body.importId ?? "").trim();
  const fingerprint = String(body.fingerprint ?? "").trim();
  const preflightApprovalFingerprint = String(
    body.preflightApprovalFingerprint ?? body.fingerprint ?? "",
  ).trim();
  if (!importId || !fingerprint) {
    return NextResponse.json(
      {
        error: "importId and fingerprint are required.",
        code: "apply_params_required",
      },
      { status: 400 },
    );
  }

  try {
    const result = await runApplyCsvImport({
      importId,
      fingerprint,
      preflightApprovalFingerprint,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CursorUsageDiscoveryError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    const message =
      error instanceof Error ? error.message : "Apply import failed.";
    if (
      message === "discovery_configuration_changed_requires_new_preflight" ||
      message === "staged_import_version_mismatch_requires_new_preflight"
    ) {
      return NextResponse.json({ error: message, code: message }, { status: 409 });
    }
    const status =
      message.startsWith("source_scope_incomplete") ||
      message.startsWith("preflight_plan_changed") ||
      message.startsWith("import_lifecycle_not_applicable")
        ? 409
        : message.includes("conflict")
          ? 409
          : 500;
    return NextResponse.json({ error: message, code: message }, { status });
  }
}
