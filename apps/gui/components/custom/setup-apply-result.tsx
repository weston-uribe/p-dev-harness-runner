"use client";

import { StatusBadge } from "@/components/custom/status-badge";
import type { SetupGuiViewModel } from "@/lib/setup-server";

interface SetupApplyResultProps {
  success: boolean;
  message: string;
  summary?: SetupGuiViewModel;
}

export function SetupApplyResult({
  success,
  message,
  summary,
}: SetupApplyResultProps) {
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-2">
        <StatusBadge
          label={success ? "Applied" : "Failed"}
          variant={success ? "success" : "destructive"}
        />
        <p className="text-sm font-medium">{message}</p>
      </div>
      {success && summary ? (
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Local files present</dt>
            <dd>{summary.overview.localFilesPresent ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Config resolved</dt>
            <dd>{summary.overview.configResolved ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">LINEAR_API_KEY</dt>
            <dd>{summary.envKeyPresence.LINEAR_API_KEY ? "Set" : "Missing"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">CURSOR_API_KEY</dt>
            <dd>{summary.envKeyPresence.CURSOR_API_KEY ? "Set" : "Missing"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">GITHUB_TOKEN</dt>
            <dd>{summary.envKeyPresence.GITHUB_TOKEN ? "Set" : "Missing"}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
