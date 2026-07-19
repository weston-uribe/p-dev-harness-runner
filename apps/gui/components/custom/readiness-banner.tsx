import type { FirstRunReadiness } from "@harness/setup/first-run-readiness";
import { AlertCircle, ArrowRight } from "lucide-react";

import { SPACING } from "@/lib/constants";
import { StatusBadge } from "@/components/custom/status-badge";
import { SectionCard } from "@/components/custom/section-card";

interface ReadinessBannerProps {
  readiness: FirstRunReadiness;
}

export function ReadinessBanner({ readiness }: ReadinessBannerProps) {
  const currentStep = readiness.steps.find(
    (step) => step.id === readiness.currentStepId,
  );

  return (
    <SectionCard
      title="Setup readiness"
      description="One recommended next action at a time."
    >
      <div className={SPACING.stackSm}>
        <div className={SPACING.inline}>
          <StatusBadge
            label={
              readiness.readyForFirstRun
                ? "Ready for first run"
                : "Setup in progress"
            }
            variant={readiness.readyForFirstRun ? "success" : "warning"}
          />
          {currentStep ? (
            <StatusBadge
              label={`Current step: ${currentStep.label}`}
              variant="secondary"
            />
          ) : null}
        </div>

        {readiness.highestPriorityBlocker ? (
          <div
            className={
              readiness.highestPriorityBlocker.tone === "setup_needed"
                ? "flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3"
                : "flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            }
          >
            {readiness.highestPriorityBlocker.tone === "setup_needed" ? (
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <div className={SPACING.stackSm}>
              <p className="text-sm font-medium">
                {readiness.highestPriorityBlocker.message
                  .replace(/^Blocked:\s*/, "")
                  .replace(/^Setup needed:\s*/, "")}
              </p>
              <p className="text-sm text-muted-foreground">
                {readiness.highestPriorityBlocker.action}
              </p>
            </div>
          </div>
        ) : readiness.nextRecommendedAction ? (
          <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className={SPACING.stackSm}>
              <p className="text-sm font-medium">Next recommended action</p>
              <p className="text-sm text-muted-foreground">
                {readiness.nextRecommendedAction.label}
              </p>
            </div>
          </div>
        ) : null}

        {readiness.nonBlockingWarnings.length > 0 &&
        !readiness.remoteSetupBlockedByUpstream ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {readiness.nonBlockingWarnings.map((warning) => (
              <li key={warning.id}>{warning.message}</li>
            ))}
          </ul>
        ) : readiness.remoteSetupBlockedByUpstream ? (
          <p className="text-sm text-muted-foreground">
            Remote setup details stay collapsed until harness repo access is fixed.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
