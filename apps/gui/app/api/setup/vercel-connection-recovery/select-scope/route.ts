import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { selectVercelRecoveryScope } from "@harness/setup/vercel-connection-recovery";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      operationId?: string;
      selectedScope?: { teamId?: string; teamName: string };
      expectedRevision?: number;
    };
    if (!body.operationId?.trim()) {
      return NextResponse.json(
        { error: "operationId is required." },
        { status: 400 },
      );
    }
    if (!body.selectedScope?.teamName?.trim()) {
      return NextResponse.json(
        { error: "selectedScope is required." },
        { status: 400 },
      );
    }
    const status = await selectVercelRecoveryScope({
      cwd: resolveHarnessWorkspaceDir(),
      operationId: body.operationId,
      selectedScope: body.selectedScope,
      expectedRevision: body.expectedRevision,
    });
    return NextResponse.json(status, {
      status: status.conflict ? 409 : 200,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Select scope failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
