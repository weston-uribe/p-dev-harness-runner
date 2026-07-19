"use client";

import { useEffect } from "react";
import { AppShell } from "@/components/custom/app-shell";
import { markConfigureClient } from "@/lib/configure-navigation-timing";

export default function ConfigureLoading() {
  useEffect(() => {
    markConfigureClient("configure_shell_paint");
  }, []);

  return (
    <AppShell showProductNavigation={false} enableHomeNavigation={false}>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
        <div className="h-8 w-56 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full animate-pulse rounded-md bg-muted/70" />
        <div className="h-4 w-5/6 animate-pulse rounded-md bg-muted/70" />
        <div className="mt-6 space-y-3">
          <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />
          <div className="h-24 animate-pulse rounded-md border border-border bg-muted/30" />
        </div>
      </div>
    </AppShell>
  );
}
