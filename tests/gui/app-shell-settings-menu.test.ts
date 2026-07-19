import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("app shell settings menu", () => {
  it("renders the polished brand lockup without legacy header copy", async () => {
    const appShell = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/app-shell.tsx"),
      "utf8",
    );
    const applicationHeader = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/custom/application-header.tsx",
      ),
      "utf8",
    );

    expect(appShell).toContain("ApplicationHeader");
    expect(appShell).not.toContain("Product Development Harness");
    expect(appShell).not.toContain("Local operator GUI");
    expect(appShell).not.toContain("ThemeToggle");
    expect(applicationHeader).toContain("PDev Harness");
    expect(applicationHeader).toContain("enableHomeNavigation");
    expect(applicationHeader).toContain('href={workflowHref}');
    expect(applicationHeader).toContain("SettingsMenu");
  });

  it("uses Radix dropdown menu for settings actions", async () => {
    const settingsMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );
    const dropdownMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/ui/dropdown-menu.tsx"),
      "utf8",
    );

    expect(settingsMenu).toContain("DropdownMenu");
    expect(settingsMenu).toContain("Dark mode");
    expect(settingsMenu).toContain("Light mode");
    expect(settingsMenu).toContain('href={settingsHref}');
    expect(settingsMenu).toContain('aria-current={isSettingsActive ? "page" : undefined}');
    const themeItemMatch = settingsMenu.match(
      /<DropdownMenuItem[\s\S]*?toggleTheme\(\)[\s\S]*?<\/DropdownMenuItem>/,
    );
    expect(themeItemMatch?.[0] ?? "").not.toContain("<Button");
    expect(dropdownMenu).toContain('@radix-ui/react-dropdown-menu');
  });

  it("keeps sticky background-matched header tokens", async () => {
    const layout = await readFile(
      path.join(process.cwd(), "apps/gui/lib/constants/layout.ts"),
      "utf8",
    );

    expect(layout).toContain('header: "sticky top-0 z-50 border-b border-border bg-background"');
    expect(layout).toContain('APP_HEADER_STICKY_CLASS = "sticky top-0 z-50"');
  });

  it("shares theme toggle logic without nesting buttons in menu items", async () => {
    const themeHook = await readFile(
      path.join(process.cwd(), "apps/gui/lib/use-theme-toggle.ts"),
      "utf8",
    );
    const settingsMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(themeHook).toContain('from "next-themes"');
    expect(themeHook).toContain("toggleTheme");
    expect(settingsMenu).toContain("useThemeToggle");
    expect(settingsMenu).toContain("toggleTheme()");
  });

  it("defaults to showing product navigation and can suppress it", async () => {
    const appShell = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/app-shell.tsx"),
      "utf8",
    );
    const applicationHeader = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/custom/application-header.tsx",
      ),
      "utf8",
    );
    const settingsMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(appShell).toContain("showProductNavigation = true");
    expect(appShell).toContain(
      "showProductNavigation={showProductNavigation}",
    );
    expect(appShell).toContain("enableHomeNavigation = true");
    expect(appShell).toContain(
      "enableHomeNavigation={enableHomeNavigation}",
    );
    expect(applicationHeader).toContain("showProductNavigation = true");
    expect(applicationHeader).toContain(
      "showProductNavigation={showProductNavigation}",
    );
    expect(applicationHeader).toContain("enableHomeNavigation = true");
    expect(settingsMenu).toContain("showProductNavigation = true");
    expect(settingsMenu).toContain("!showProductNavigation");
    expect(settingsMenu).toContain("{showProductNavigation ? (");
    expect(settingsMenu).toContain("DropdownMenuSeparator");
    expect(settingsMenu).toContain("Workflow");
    expect(settingsMenu).toContain("Dark mode");
    expect(settingsMenu).toContain("Light mode");
  });
});
