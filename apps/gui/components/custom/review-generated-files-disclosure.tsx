"use client";

import { LocalWritePreview } from "@/components/custom/local-write-preview";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewGeneratedFilesDisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading: boolean;
  previewError?: string;
  envPreview?: string;
  configPreview?: string;
  validationError?: string;
  previewIsCurrent: boolean;
}

export function ReviewGeneratedFilesDisclosure({
  open,
  onOpenChange,
  isLoading,
  previewError,
  envPreview,
  configPreview,
  validationError,
  previewIsCurrent,
}: ReviewGeneratedFilesDisclosureProps) {
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
        Review generated files
      </summary>
      <div className="mt-3 space-y-3">
        {isLoading ? (
          <>
            <p className="text-sm text-muted-foreground">
              Generating redacted local file changes…
            </p>
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-4 w-[60%]" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-[40%]" />
              <Skeleton className="h-32 w-full" />
            </div>
          </>
        ) : previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : (
          <LocalWritePreview
            variant="guided"
            envPreview={previewIsCurrent ? envPreview : undefined}
            configPreview={previewIsCurrent ? configPreview : undefined}
            validationError={previewIsCurrent ? validationError : undefined}
          />
        )}
      </div>
    </details>
  );
}
