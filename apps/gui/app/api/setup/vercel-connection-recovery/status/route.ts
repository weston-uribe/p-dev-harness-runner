import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { getVercelConnectionRecoveryStatus } from "@harness/setup/vercel-connection-recovery";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      operationId?: string;
    };
    const status = await getVercelConnectionRecoveryStatus({
      cwd: resolveHarnessWorkspaceDir(),
      operationId: body.operationId,
    });
    return NextResponse.json(status);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Vercel recovery status failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
