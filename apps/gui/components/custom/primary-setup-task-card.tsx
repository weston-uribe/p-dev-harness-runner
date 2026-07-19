"use client";

import type { PrimarySetupTask } from "@harness/setup/first-run-readiness";
import { AlertCircle, ArrowRight } from "lucide-react";

import { SPACING } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/custom/section-card";
import { cn } from "@/lib/utils";

interface PrimarySetupTaskCardProps {
  task: PrimarySetupTask;
  onPrimaryAction: () => void;
  onShowDetails: () => void;
}

export function PrimarySetupTaskCard({
  task,
  onPrimaryAction,
  onShowDetails,
}: PrimarySetupTaskCardProps) {
  const isSetupNeeded = task.tone === "setup_needed";

  return (
    <SectionCard
      title={task.title}
      description="One clear action at a time."
    >
      <div className={SPACING.stackSm}>
        <div
          className={cn(
            "flex items-start gap-3 rounded-md border p-3",
            isSetupNeeded
              ? "border-border bg-muted/30"
              : "border-destructive/30 bg-destructive/5",
          )}
        >
          {isSetupNeeded ? (
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div className={SPACING.stackSm}>
            <p className="text-sm font-medium">{task.problem}</p>
            <p className="text-sm text-muted-foreground">{task.whyItMatters}</p>
          </div>
        </div>

        <div className={SPACING.stackSm}>
          <p className="text-sm font-medium">Needed from you</p>
          <p className="text-sm text-muted-foreground">{task.neededFromYou}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onPrimaryAction}>
            {task.primaryCtaLabel}
          </Button>
          <Button type="button" variant="outline" onClick={onShowDetails}>
            {task.secondaryCtaLabel}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
