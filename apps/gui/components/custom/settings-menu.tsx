"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { ChevronDown, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useThemeToggle } from "@/lib/use-theme-toggle";

type SettingsMenuProps = {
  settingsHref?: string;
  isSettingsActive?: boolean;
  workflowHref?: string;
  isWorkflowActive?: boolean;
  showProductNavigation?: boolean;
};

export function SettingsMenu({
  settingsHref = "/settings",
  isSettingsActive = false,
  workflowHref = "/workflow",
  isWorkflowActive = false,
  showProductNavigation = true,
}: SettingsMenuProps) {
  const { mounted, isDark, toggleTheme } = useThemeToggle();
  const router = useRouter();
  const prefetchedRoutesRef = useRef<Set<string>>(new Set());

  const prefetchRoute = useCallback(
    (href: string) => {
      if (prefetchedRoutesRef.current.has(href)) {
        return;
      }
      prefetchedRoutesRef.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !showProductNavigation) {
        return;
      }
      prefetchRoute(settingsHref);
      prefetchRoute(workflowHref);
    },
    [prefetchRoute, settingsHref, showProductNavigation, workflowHref],
  );

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="cursor-pointer gap-1.5">
          Settings
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleTheme();
          }}
        >
          {mounted && isDark ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
          <span>{mounted && isDark ? "Light mode" : "Dark mode"}</span>
        </DropdownMenuItem>
        {showProductNavigation ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                href={workflowHref}
                aria-current={isWorkflowActive ? "page" : undefined}
                onMouseEnter={() => prefetchRoute(workflowHref)}
                onFocus={() => prefetchRoute(workflowHref)}
              >
                Workflow
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                href={settingsHref}
                aria-current={isSettingsActive ? "page" : undefined}
                onMouseEnter={() => prefetchRoute(settingsHref)}
                onFocus={() => prefetchRoute(settingsHref)}
              >
                Settings
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
