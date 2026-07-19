import { NextResponse } from "next/server";
import { z } from "zod";
import {
  saveWorkflowOptionalPhases,
  WorkflowModelSyncError,
} from "@/lib/workflow-server";
import { toPublicApiError } from "@harness/gui/public-client-payload";

const saveRequestSchema = z.object({
  planReviewEnabled: z.boolean(),
  planReviewCycleLimit: z.number().int().min(1),
  codeReviewEnabled: z.boolean(),
  codeReviewCycleLimit: z.number().int().min(1),
  expectedConfigFingerprint: z.string().min(1),
  sourceMode: z.enum(["live", "fixture"]).optional(),
  fixtureId: z.string().optional(),
  scopeId: z.string().optional(),
});

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ saved: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = saveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { saved: false, error: "Invalid workflow optional phase save request." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const sourceMode =
    parsed.data.sourceMode ??
    (url.searchParams.get("source") === "fixture" ? "fixture" : "live");
  const fixtureId =
    parsed.data.fixtureId ?? url.searchParams.get("fixture") ?? undefined;
  const scopeId =
    parsed.data.scopeId ?? url.searchParams.get("scope") ?? undefined;

  try {
    const result = await saveWorkflowOptionalPhases({
      planReviewEnabled: parsed.data.planReviewEnabled,
      planReviewCycleLimit: parsed.data.planReviewCycleLimit,
      codeReviewEnabled: parsed.data.codeReviewEnabled,
      codeReviewCycleLimit: parsed.data.codeReviewCycleLimit,
      expectedConfigFingerprint: parsed.data.expectedConfigFingerprint,
      sourceMode,
      fixtureId,
      scopeId,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkflowModelSyncError) {
      const publicError = toPublicApiError(error, {
        fallbackCode: error.code,
        fallbackMessage: "Couldn't save workflow settings.",
      });
      return NextResponse.json(
        {
          saved: false,
          error: publicError.message,
          code: publicError.code,
        },
        { status: 422 },
      );
    }
    const publicError = toPublicApiError(error, {
      fallbackCode: "workflow_optional_phases_save_failed",
      fallbackMessage: "Couldn't save workflow settings.",
    });
    return NextResponse.json(
      {
        saved: false,
        error: publicError.message,
        code: publicError.code,
      },
      { status: 500 },
    );
  }
}
