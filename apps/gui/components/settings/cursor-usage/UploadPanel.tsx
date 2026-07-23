"use client";

import { useRef, useState } from "react";

interface UploadPanelProps {
  file: File | null;
  disabled?: boolean;
  onFileSelected: (file: File | null) => void;
}

export function UploadPanel({
  file,
  disabled = false,
  onFileSelected,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const next = files?.[0] ?? null;
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".csv")) {
      return;
    }
    onFileSelected(next);
  };

  return (
    <div
      className={`rounded-md border border-dashed px-6 py-8 text-center ${
        dragOver ? "border-primary bg-muted/40" : "border-muted-foreground/30"
      }`}
      data-testid="cursor-usage-upload-panel"
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (disabled) return;
        handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        disabled={disabled}
        data-testid="cursor-usage-file-input"
        onChange={(event) => handleFiles(event.target.files)}
      />
      <p className="text-sm text-muted-foreground">
        Drag and drop the official Cursor usage CSV, or{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          choose a file
        </button>
        .
      </p>
      {file ? (
        <p className="mt-2 text-sm font-medium" data-testid="cursor-usage-file-name">
          {file.name}
        </p>
      ) : null}
    </div>
  );
}
