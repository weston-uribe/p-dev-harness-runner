import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("gui design-system boundaries", () => {
  it("keeps shadcn primitives under components/ui", async () => {
    const uiDir = path.join(process.cwd(), "apps/gui/components/ui");
    const button = await readFile(path.join(uiDir, "button.tsx"), "utf8");
    const card = await readFile(path.join(uiDir, "card.tsx"), "utf8");

    expect(button).toContain("buttonVariants");
    expect(button).toContain("cursor-pointer");
    expect(card).toContain("CardHeader");
  });

  it("exports static Tailwind token strings", async () => {
    const constantsDir = path.join(process.cwd(), "apps/gui/lib/constants");
    const layout = await readFile(path.join(constantsDir, "layout.ts"), "utf8");
    const spacing = await readFile(path.join(constantsDir, "spacing.ts"), "utf8");
    const responsive = await readFile(
      path.join(constantsDir, "breakpoints.ts"),
      "utf8",
    );
    const form = await readFile(path.join(constantsDir, "form.ts"), "utf8");

    expect(layout).toContain('page: "mx-auto w-full max-w-5xl"');
    expect(layout).toContain("max-w-7xl");
    expect(layout).toContain('configureContent: "mx-auto w-full max-w-3xl"');
    expect(spacing).toContain('section: "space-y-6"');
    expect(responsive).toContain("md:text-3xl");
    expect(form).toContain("fieldGrid");
    expect(form).toContain("guidedSelect");
    expect(form).toContain("h-9");
  });

  it("keeps harness form components under components/custom", async () => {
    const customDir = path.join(process.cwd(), "apps/gui/components/custom");
    const envForm = await readFile(
      path.join(customDir, "environment-config-form.tsx"),
      "utf8",
    );
    const confirmation = await readFile(
      path.join(customDir, "local-write-confirmation.tsx"),
      "utf8",
    );
    const stepper = await readFile(
      path.join(customDir, "first-run-stepper.tsx"),
      "utf8",
    );
    const serviceIcons = await readFile(
      path.join(customDir, "service-icons.tsx"),
      "utf8",
    );

    expect(envForm).toContain("EnvironmentConfigForm");
    expect(confirmation).toContain("LocalWriteConfirmation");
    expect(stepper).toContain("FirstRunStepper");
    expect(stepper).toContain("cursor-pointer");
    expect(serviceIcons).toContain("SiLinear");
    expect(serviceIcons).toContain("SiGithub");
    expect(serviceIcons).toContain("SiCursor");
  });

  it("uses minimal next-themes provider and shared theme toggle hook", async () => {
    const layout = await readFile(
      path.join(process.cwd(), "apps/gui/app/layout.tsx"),
      "utf8",
    );
    const themeProvider = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/theme-provider.tsx"),
      "utf8",
    );
    const themeHook = await readFile(
      path.join(process.cwd(), "apps/gui/lib/use-theme-toggle.ts"),
      "utf8",
    );
    const settingsMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );
    const globals = await readFile(
      path.join(process.cwd(), "apps/gui/styles/globals.css"),
      "utf8",
    );

    expect(layout).toContain("ThemeProvider");
    expect(layout).toContain("suppressHydrationWarning");
    expect(themeProvider).toContain('from "next-themes"');
    expect(themeProvider).toContain('attribute="class"');
    expect(themeHook).toContain('from "next-themes"');
    expect(settingsMenu).toContain("useThemeToggle");
    expect(globals).toContain(".dark");
  });

  it("includes dropdown menu primitive for settings navigation", async () => {
    const dropdownMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/ui/dropdown-menu.tsx"),
      "utf8",
    );
    const layout = await readFile(
      path.join(process.cwd(), "apps/gui/lib/constants/layout.ts"),
      "utf8",
    );
    const progress = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/custom/guided-setup-progress.tsx",
      ),
      "utf8",
    );

    expect(dropdownMenu).toContain('@radix-ui/react-dropdown-menu');
    expect(layout).toContain("bg-background");
    expect(layout).toContain("sticky top-0 z-50");
    expect(layout).toContain("headerInner");
    expect(progress).toContain('from "framer-motion"');
  });

  it("keeps guided visual affordance contracts", async () => {
    const guiRoot = path.join(process.cwd(), "apps/gui");
    const guidedSelect = await readFile(
      path.join(guiRoot, "components/ui/guided-select.tsx"),
      "utf8",
    );
    const dataSharing = await readFile(
      path.join(guiRoot, "components/custom/data-sharing-preferences.tsx"),
      "utf8",
    );
    const deploymentsEditor = await readFile(
      path.join(
        guiRoot,
        "components/settings/editors/deployments-settings-editor.tsx",
      ),
      "utf8",
    );
    const header = await readFile(
      path.join(guiRoot, "components/custom/application-header.tsx"),
      "utf8",
    );

    expect(guidedSelect).toContain("FORM.guidedSelect");
    expect(deploymentsEditor).toContain("GuidedSelect");
    expect(dataSharing).toContain("cursor-pointer");
    expect(header).toContain("border border-foreground bg-transparent");
  });
});
