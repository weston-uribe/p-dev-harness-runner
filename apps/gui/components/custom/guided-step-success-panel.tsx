"use client";

import { Button } from "@/components/ui/button";

type GuidedStepSuccessPanelProps = {
  heading: string;
  explanation: string;
  continueLabel: string;
  onContinue: () => void;
  details?: string[];
};

export function GuidedStepSuccessPanel({
  heading,
  explanation,
  continueLabel,
  onContinue,
  details,
}: GuidedStepSuccessPanelProps) {
  return (
    <div
      className="space-y-4 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4"
      data-testid="guided-step-success-panel"
      role="status"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-emerald-600 text-sm font-semibold text-emerald-700 dark:border-emerald-400 dark:text-emerald-300"
          aria-hidden="true"
        >
          ✓
        </span>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
          <p className="text-sm text-muted-foreground">{explanation}</p>
          {details && details.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <Button type="button" onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}
