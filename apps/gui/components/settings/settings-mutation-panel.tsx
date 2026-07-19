"use client";

import { Button } from "@/components/ui/button";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import type { SettingsMutationPhase } from "@/lib/settings/settings-mutation";

type SettingsMutationPanelProps = {
  title?: string;
  explanation?: string | null;
  previewSummary?: string | null;
  phase: SettingsMutationPhase;
  error?: string | null;
  successMessage?: string | null;
  previewPolicy?: "required" | "optional";
  confirmScope?:
    | "remote-secret-write"
    | "vercel-bridge-write"
    | "remote-repo-write"
    | "linear-write";
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onPreview?: () => void;
  onApply?: () => void;
  previewLabel?: string;
  applyLabel?: string;
  disablePreview?: boolean;
  disableApply?: boolean;
};

export function SettingsMutationPanel({
  title = "Apply changes",
  explanation,
  previewSummary,
  phase,
  error,
  successMessage,
  confirmScope,
  confirmed,
  onConfirmedChange,
  onPreview,
  onApply,
  previewLabel = "Preview changes",
  applyLabel = "Apply changes",
  previewPolicy = "required",
  disablePreview = false,
  disableApply = false,
}: SettingsMutationPanelProps) {
  const busy = phase === "previewing" || phase === "applying";
  const applyRequiresPreview = previewPolicy === "required";
  const previewIsOptional = previewPolicy === "optional";

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {explanation ? (
          <p className="text-sm text-muted-foreground">{explanation}</p>
        ) : null}
      </div>

      {onPreview ? (
        <div className="space-y-2 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {previewIsOptional ? (
              <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                Optional
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || disablePreview}
              onClick={onPreview}
            >
              {phase === "previewing" ? "Previewing…" : previewLabel}
            </Button>
          </div>
          {previewIsOptional ? (
            <p className="text-right text-xs text-muted-foreground">
              Review the planned changes before applying.
            </p>
          ) : null}
        </div>
      ) : null}

      {previewSummary ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
          {previewSummary}
        </pre>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {successMessage ? (
        <p className="text-sm text-muted-foreground">{successMessage}</p>
      ) : null}

      {confirmScope ? (
        <RemoteActionConfirmation
          scope={confirmScope}
          variant="advanced"
          confirmed={confirmed}
          disabled={busy}
          onConfirmedChange={onConfirmedChange}
        />
      ) : null}

      {onApply ? (
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={
              busy ||
              disableApply ||
              (confirmScope ? !confirmed : false) ||
              (applyRequiresPreview && !previewSummary)
            }
            onClick={onApply}
          >
            {phase === "applying" ? "Applying…" : applyLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
