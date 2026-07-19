import Link from "next/link";

import { SettingsMenu } from "@/components/custom/settings-menu";
import { LAYOUT } from "@/lib/constants/layout";

type ApplicationHeaderProps = {
  settingsHref?: string;
  isSettingsActive?: boolean;
  workflowHref?: string;
  isWorkflowActive?: boolean;
  showProductNavigation?: boolean;
  enableHomeNavigation?: boolean;
};

function BrandLockup() {
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-foreground bg-transparent text-sm font-semibold text-foreground"
      >
        P
      </span>
      <span className="truncate text-sm font-semibold tracking-tight sm:text-base">
        PDev Harness
      </span>
    </>
  );
}

export function ApplicationHeader({
  settingsHref,
  isSettingsActive,
  workflowHref = "/workflow",
  isWorkflowActive = false,
  showProductNavigation = true,
  enableHomeNavigation = true,
}: ApplicationHeaderProps) {
  return (
    <header className={LAYOUT.header}>
      <div className={LAYOUT.headerInner}>
        {enableHomeNavigation ? (
          <Link
            href={workflowHref}
            className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandLockup />
          </Link>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5" aria-hidden="false">
            <BrandLockup />
          </div>
        )}
        <SettingsMenu
          settingsHref={settingsHref}
          isSettingsActive={isSettingsActive}
          workflowHref={workflowHref}
          isWorkflowActive={isWorkflowActive}
          showProductNavigation={showProductNavigation}
        />
      </div>
    </header>
  );
}
