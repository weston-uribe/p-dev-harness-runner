"use client";

import { RemoteActionPreview } from "@/components/custom/remote-action-preview";
import { Skeleton } from "@/components/ui/skeleton";
import type { RemoteHarnessSecretPreview } from "@harness/setup/remote-actions";

interface ReviewCloudSecretsDisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading: boolean;
  previewError?: string;
  preview?: RemoteHarnessSecretPreview;
  previewIsCurrent: boolean;
}

export function ReviewCloudSecretsDisclosure({
  open,
  onOpenChange,
  isLoading,
  previewError,
  preview,
  previewIsCurrent,
}: ReviewCloudSecretsDisclosureProps) {
  return (
    <details
      open={open}
      className="rounded-md border border-border bg-background p-3"
    >
      <summary
        className="cursor-pointer text-sm font-medium"
        onClick={(event) => {
          event.preventDefault();
          onOpenChange(!open);
        }}
      >
        Review generated secrets (optional)
      </summary>
      <div className="mt-3 space-y-3">
        {isLoading ? (
          <>
            <p className="text-sm text-muted-foreground">
              Generating redacted cloud secrets preview…
            </p>
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-4 w-[60%]" />
              <Skeleton className="h-24 w-full" />
            </div>
          </>
        ) : previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : (
          <RemoteActionPreview
            harnessSecretPreview={previewIsCurrent ? preview : undefined}
          />
        )}
      </div>
    </details>
  );
}
