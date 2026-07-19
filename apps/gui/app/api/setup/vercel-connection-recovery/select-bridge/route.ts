import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { selectVercelRecoveryBridge } from "@harness/setup/vercel-connection-recovery";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      operationId?: string;
      projectId?: string;
      expectedRevision?: number;
    };
    if (!body.operationId?.trim() || !body.projectId?.trim()) {
      return NextResponse.json(
        { error: "operationId and projectId are required." },
        { status: 400 },
      );
    }
    const status = await selectVercelRecoveryBridge({
      cwd: resolveHarnessWorkspaceDir(),
      operationId: body.operationId,
      projectId: body.projectId,
      expectedRevision: body.expectedRevision,
    });
    return NextResponse.json(status, {
      status: status.conflict ? 409 : 200,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Select bridge failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
