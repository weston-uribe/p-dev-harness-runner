import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("configure navigation contracts", () => {
  it("provides a configure loading boundary", () => {
    const loadingPath = path.join(
      repoRoot,
      "apps/gui/app/settings/configure/loading.tsx",
    );
    expect(existsSync(loadingPath)).toBe(true);
    const source = readFileSync(loadingPath, "utf8");
    expect(source).toContain("AppShell");
    expect(source).toContain("showProductNavigation={false}");
    expect(source).toContain("enableHomeNavigation={false}");
    expect(source).toContain("markConfigureClient");
    expect(source).toContain("configure_shell_paint");
  });

  it("instruments configure page loaders with sanitized timing marks", () => {
    const pageSource = readFileSync(
      path.join(repoRoot, "apps/gui/app/settings/configure/page.tsx"),
      "utf8",
    );
    const timingSource = readFileSync(
      path.join(repoRoot, "apps/gui/lib/configure-navigation-timing.ts"),
      "utf8",
    );

    expect(pageSource).toContain("markConfigureServerStart");
    expect(pageSource).toContain("configure_loader_remote_summary");
    expect(pageSource).toContain("Promise.all");
    expect(pageSource).toContain("showProductNavigation={false}");
    expect(pageSource).toContain("enableHomeNavigation={false}");
    expect(timingSource).toContain("[configure-timing]");
    expect(timingSource).not.toMatch(/LINEAR_API_KEY|GITHUB_TOKEN|secret/i);
  });

  it("suppresses brand home navigation while initial setup is incomplete", () => {
    const pageSource = readFileSync(
      path.join(repoRoot, "apps/gui/app/settings/configure/page.tsx"),
      "utf8",
    );
    const headerSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/application-header.tsx"),
      "utf8",
    );
    const shellSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/app-shell.tsx"),
      "utf8",
    );

    expect(pageSource).toContain("enableHomeNavigation={false}");
    expect(shellSource).toContain("enableHomeNavigation = true");
    expect(shellSource).toContain(
      "enableHomeNavigation={enableHomeNavigation}",
    );
    expect(headerSource).toContain("enableHomeNavigation = true");
    expect(headerSource).toContain("enableHomeNavigation ?");
    expect(headerSource).toContain('href={workflowHref}');
    expect(headerSource).toMatch(
      /enableHomeNavigation \? \([\s\S]*?<Link[\s\S]*href=\{workflowHref\}/,
    );
    expect(headerSource).toMatch(
      /: \(\s*<div className="flex min-w-0 items-center gap-2\.5"/,
    );
  });

  it("suppresses product navigation prefetch while initial setup is incomplete", () => {
    const pageSource = readFileSync(
      path.join(repoRoot, "apps/gui/app/settings/configure/page.tsx"),
      "utf8",
    );
    const menuSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(pageSource).toContain("showProductNavigation={false}");
    expect(pageSource).toContain("isInitialSetupComplete");
    expect(pageSource).toContain("redirect(WORKFLOW_ROUTE)");
    expect(menuSource).toContain("!showProductNavigation");
    expect(menuSource).toContain("{showProductNavigation ? (");
  });

  it("prefetches settings and workflow routes only when product navigation is shown", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(source).toContain("router.prefetch");
    expect(source).toContain("onOpenChange={handleOpenChange}");
    expect(source).toContain("if (!open || !showProductNavigation)");
    expect(source).toContain("onMouseEnter={() => prefetchRoute(workflowHref)}");
    expect(source).toContain("onMouseEnter={() => prefetchRoute(settingsHref)}");
    expect(source).toContain('workflowHref = "/workflow"');
    expect(source).toContain('settingsHref = "/settings"');
    expect(source).toContain("showProductNavigation = true");
  });
});
