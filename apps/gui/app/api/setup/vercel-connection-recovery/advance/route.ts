import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { advanceVercelConnectionRecovery } from "@harness/setup/vercel-connection-recovery";
import {
  loadRemoteSetupSummary,
  loadSetupSummary,
} from "@/lib/setup-server";
import { reconcileInitialSetupCompletion } from "@harness/setup/initial-setup-lifecycle";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      operationId?: string;
      expectedRevision?: number;
    };
    if (!body.operationId?.trim()) {
      return NextResponse.json(
        { error: "operationId is required." },
        { status: 400 },
      );
    }
    const cwd = resolveHarnessWorkspaceDir();
    const status = await advanceVercelConnectionRecovery({
      cwd,
      operationId: body.operationId,
      expectedRevision: body.expectedRevision,
      deps: {
        loadSetupSummary: async () => loadSetupSummary(),
        loadRemoteSummary: async () => loadRemoteSetupSummary(),
        reconcileCompletion: reconcileInitialSetupCompletion,
      },
    });
    return NextResponse.json(status, {
      status: status.conflict ? 409 : 200,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Vercel recovery advance failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
