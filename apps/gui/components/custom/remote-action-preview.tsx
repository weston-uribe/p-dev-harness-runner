"use client";

import { PreviewPanel } from "@/components/custom/preview-panel";
import type {
  RemoteHarnessSecretPreview,
  RemoteTargetWorkflowPreview,
} from "@harness/setup/remote-actions";

interface RemoteActionPreviewProps {
  harnessSecretPreview?: RemoteHarnessSecretPreview;
  targetWorkflowPreview?: RemoteTargetWorkflowPreview;
}

export function RemoteActionPreview({
  harnessSecretPreview,
  targetWorkflowPreview,
}: RemoteActionPreviewProps) {
  if (!harnessSecretPreview && !targetWorkflowPreview) {
    return (
      <p className="text-sm text-muted-foreground">
        Generate a preview before confirming any remote write.
      </p>
    );
  }

  if (harnessSecretPreview) {
    return (
      <div className="space-y-4">
        {harnessSecretPreview.validationError ? (
          <p className="text-sm text-destructive">
            {harnessSecretPreview.validationError}
          </p>
        ) : null}
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Harness dispatch repo</dt>
            <dd className="font-medium break-all">
              {harnessSecretPreview.harnessDispatchRepo}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Repo access</dt>
            <dd className="font-medium">{harnessSecretPreview.repoAccess}</dd>
          </div>
        </dl>
        <PreviewPanel
          title="Secret write plan (key names only)"
          content={harnessSecretPreview.secretWritePlan
            .map(
              (entry) =>
                `${entry.name}: ${entry.action} (${entry.source})`,
            )
            .join("\n")}
        />
        <PreviewPanel
          title="Manual copy-paste alternative"
          content={harnessSecretPreview.manualInstructions.join("\n")}
        />
      </div>
    );
  }

  if (targetWorkflowPreview) {
    return (
      <div className="space-y-4">
        {targetWorkflowPreview.validationError ? (
          <p className="text-sm text-destructive">
            {targetWorkflowPreview.validationError}
          </p>
        ) : null}
        <PreviewPanel
          title="Workflow install preview"
          content={targetWorkflowPreview.workflowPreviewSummary}
        />
        <PreviewPanel
          title="Manual copy-paste alternative"
          content={targetWorkflowPreview.manualInstructions.join("\n")}
        />
      </div>
    );
  }

  return null;
}
