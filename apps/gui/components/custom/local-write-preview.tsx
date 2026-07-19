"use client";

import { PreviewPanel } from "@/components/custom/preview-panel";

interface LocalWritePreviewProps {
  envPreview?: string;
  configPreview?: string;
  validationError?: string;
  variant?: "guided" | "advanced";
  isLoading?: boolean;
}

export function LocalWritePreview({
  envPreview,
  configPreview,
  validationError,
  variant = "advanced",
  isLoading = false,
}: LocalWritePreviewProps) {
  if (isLoading) {
    return null;
  }

  if (!envPreview && !configPreview && !validationError) {
    if (variant === "guided") {
      return null;
    }

    return (
      <p className="text-sm text-muted-foreground">
        Generate a preview to review redacted local file changes before applying.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {validationError ? (
        <p className="text-sm text-destructive">{validationError}</p>
      ) : null}
      {envPreview ? (
        <PreviewPanel title=".env.local preview (redacted)" content={envPreview} />
      ) : null}
      {configPreview ? (
        <PreviewPanel
          title=".harness/config.local.json preview"
          content={configPreview}
        />
      ) : null}
    </div>
  );
}
