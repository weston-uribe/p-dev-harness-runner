import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { startVercelConnectionRecovery } from "@harness/setup/vercel-connection-recovery";
import {
  loadRemoteSetupSummary,
  loadSetupSummary,
} from "@/lib/setup-server";
import { reconcileInitialSetupCompletion } from "@harness/setup/initial-setup-lifecycle";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      selectedScope?: { teamId?: string; teamName: string };
    };
    const cwd = resolveHarnessWorkspaceDir();
    const status = await startVercelConnectionRecovery({
      cwd,
      selectedScope: body.selectedScope,
      deps: {
        loadSetupSummary: async () => loadSetupSummary(),
        loadRemoteSummary: async () => loadRemoteSetupSummary(),
        reconcileCompletion: reconcileInitialSetupCompletion,
      },
    });
    return NextResponse.json(status);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Vercel recovery failed to start";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
