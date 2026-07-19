import { NextResponse } from "next/server";
import { z } from "zod";
import {
  saveWorkflowModel,
  WorkflowModelSyncError,
} from "@/lib/workflow-server";
import { isRoleModelRole } from "@harness/config/role-models";
import { toPublicApiError } from "@harness/gui/public-client-payload";

const saveRequestSchema = z.object({
  role: z.string().min(1),
  modelId: z.string().min(1),
  params: z.array(
    z.object({
      id: z.string().min(1),
      value: z.string(),
    }),
  ),
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
      { saved: false, error: "Invalid workflow model save request." },
      { status: 400 },
    );
  }

  if (!isRoleModelRole(parsed.data.role)) {
    return NextResponse.json(
      { saved: false, error: `Unknown role "${parsed.data.role}".` },
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
    const result = await saveWorkflowModel({
      role: parsed.data.role,
      modelId: parsed.data.modelId,
      params: parsed.data.params,
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
        fallbackMessage: "Couldn't save model settings.",
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
      fallbackCode: "workflow_model_save_failed",
      fallbackMessage: "Couldn't save model settings.",
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
