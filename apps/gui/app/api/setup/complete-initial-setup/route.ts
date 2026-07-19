import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  completeInitialSetupFromServer,
  formatCompletionEvidenceFailureMessage,
} from "@harness/setup/initial-setup-lifecycle";
import { loadRemoteSetupSummary, loadSetupSummary } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const cwd = resolveHarnessWorkspaceDir();
    const [setupSummary, remoteSummary] = await Promise.all([
      loadSetupSummary(),
      loadRemoteSetupSummary(),
    ]);

    const result = await completeInitialSetupFromServer({
      cwd,
      setupSummary,
      remoteSummary,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          completed: false,
          evidence: result.evidence,
          unmet: result.reasons.map((reason) => reason.field),
          reasons: result.reasons,
          error: formatCompletionEvidenceFailureMessage(result.reasons),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      completed: true,
      completedAt: result.state.initialSetup?.completedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        completed: false,
        error:
          error instanceof Error
            ? error.message
            : "Initial setup completion failed.",
      },
      { status: 500 },
    );
  }
}
