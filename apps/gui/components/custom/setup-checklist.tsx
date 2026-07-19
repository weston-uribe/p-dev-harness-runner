import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { SPACING } from "@/lib/constants";
import { cn } from "@/lib/utils";

export type ChecklistItemStatus = "pending" | "complete" | "blocked";

interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
  status?: ChecklistItemStatus;
}

interface SetupChecklistProps {
  items: ChecklistItem[];
  className?: string;
}

function checklistIcon(status: ChecklistItemStatus | undefined) {
  switch (status) {
    case "complete":
      return CheckCircle2;
    case "blocked":
      return XCircle;
    default:
      return Circle;
  }
}

function checklistIconClass(status: ChecklistItemStatus | undefined): string {
  switch (status) {
    case "complete":
      return "text-emerald-600";
    case "blocked":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function SetupChecklist({ items, className }: SetupChecklistProps) {
  return (
    <ul className={cn(SPACING.list, className)}>
      {items.map((item) => {
        const Icon = checklistIcon(item.status);
        return (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3"
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                checklistIconClass(item.status),
              )}
            />
            <div className={SPACING.stackSm}>
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-sm text-muted-foreground">{item.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface DoctorChecklistProps {
  checks: Array<{
    label: string;
    ok: boolean;
    detail?: string;
    skipped?: boolean;
  }>;
  className?: string;
}

export function DoctorChecklist({ checks, className }: DoctorChecklistProps) {
  return (
    <ul className={cn(SPACING.list, className)}>
      {checks.map((check) => {
        const Icon = check.skipped
          ? Circle
          : check.ok
            ? CheckCircle2
            : XCircle;
        const iconClass = check.skipped
          ? "text-muted-foreground"
          : check.ok
            ? "text-emerald-600"
            : "text-destructive";

        return (
          <li key={check.label} className="flex items-start gap-3">
            <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
            <div className={SPACING.stackSm}>
              <p className="text-sm font-medium">{check.label}</p>
              {check.detail ? (
                <p className="text-sm text-muted-foreground">{check.detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export type LocalReadinessUiStatus =
  | "pending"
  | "checking"
  | "passed"
  | "failed";

interface LocalReadinessCheckRow {
  id: string;
  label: string;
  status: LocalReadinessUiStatus;
  detail?: string;
  action?: string;
}

interface LocalReadinessChecklistProps {
  checks: LocalReadinessCheckRow[];
  className?: string;
}

function localReadinessIcon(status: LocalReadinessUiStatus) {
  switch (status) {
    case "passed":
      return CheckCircle2;
    case "failed":
      return XCircle;
    case "checking":
      return Loader2;
    default:
      return Circle;
  }
}

function localReadinessIconClass(status: LocalReadinessUiStatus): string {
  switch (status) {
    case "passed":
      return "text-emerald-600";
    case "failed":
      return "text-destructive";
    case "checking":
      return "text-muted-foreground animate-spin";
    default:
      return "text-muted-foreground";
  }
}

function localReadinessStatusLabel(status: LocalReadinessUiStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "checking":
      return "Checking";
    default:
      return "Pending";
  }
}

export function LocalReadinessChecklist({
  checks,
  className,
}: LocalReadinessChecklistProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;

  return (
    <ul className={cn(SPACING.list, className)}>
      <AnimatePresence initial={false}>
        {checks.map((check) => {
          const Icon = localReadinessIcon(check.status);
          return (
            <motion.li
              key={check.id}
              layout={!prefersReducedMotion}
              initial={
                prefersReducedMotion ? false : { opacity: 0, y: 8, scale: 0.98 }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                prefersReducedMotion ? undefined : { opacity: 0, y: -4, scale: 0.98 }
              }
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { duration: 0.24, ease: [0.2, 0, 0, 1] }
              }
              className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  localReadinessIconClass(check.status),
                )}
              />
              <div className={cn(SPACING.stackSm, "min-w-0 flex-1")}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{check.label}</p>
                  <span className="text-xs text-muted-foreground">
                    {localReadinessStatusLabel(check.status)}
                  </span>
                </div>
                {check.detail ? (
                  <p className="text-sm text-muted-foreground">{check.detail}</p>
                ) : null}
                {check.status === "failed" && check.action ? (
                  <p className="text-sm text-foreground">{check.action}</p>
                ) : null}
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
