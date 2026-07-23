"use client";

interface ApplyConfirmProps {
  confirmed: boolean;
  disabled: boolean;
  applying: boolean;
  onConfirmedChange: (value: boolean) => void;
  onApply: () => void;
}

export function ApplyConfirm({
  confirmed,
  disabled,
  applying,
  onConfirmedChange,
  onApply,
}: ApplyConfirmProps) {
  return (
    <div
      className="space-y-3 rounded-md border p-4"
      data-testid="cursor-usage-apply-panel"
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || applying}
          data-testid="cursor-usage-apply-confirm"
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
        <span>
          I confirm this import should write score-only Cursor usage data to
          Langfuse phase traces. This does not mutate observations.
        </span>
      </label>
      <button
        type="button"
        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={disabled || !confirmed || applying}
        data-testid="cursor-usage-apply-button"
        onClick={onApply}
      >
        {applying ? "Applying…" : "Apply import"}
      </button>
    </div>
  );
}
