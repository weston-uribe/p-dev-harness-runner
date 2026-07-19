import { NextResponse } from "next/server";
import { loadWorkflowBootstrap } from "@/lib/workflow-server";
import { toPublicApiError } from "@harness/gui/public-client-payload";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") ?? undefined;
  const fixture = url.searchParams.get("fixture") ?? undefined;
  const scope = url.searchParams.get("scope") ?? undefined;

  try {
    const payload = await loadWorkflowBootstrap({ source, fixture, scope });
    return NextResponse.json(payload);
  } catch (error) {
    const publicError = toPublicApiError(error, {
      fallbackCode: "workflow_bootstrap_failed",
      fallbackMessage: "Workflow bootstrap failed.",
    });
    return NextResponse.json(
      {
        error: publicError.message,
        code: publicError.code,
      },
      { status: 500 },
    );
  }
}
