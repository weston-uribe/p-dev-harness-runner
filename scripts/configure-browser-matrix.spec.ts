import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

const screenshotDir = "/tmp/configure-validation";
const workspaceMarkerPath = "/tmp/configure-browser-workspace-path.txt";

function resolveWorkspaceDir(): string {
  const fromEnv = process.env.CONFIGURE_BROWSER_WORKSPACE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return readFileSync(workspaceMarkerPath, "utf8").trim();
}

const VERCEL_BRIDGE_OPTIONS = {
  scopes: [{ id: "team-1", label: "Acme (acme)", kind: "team" }],
  projects: [{ id: "proj-1", name: "harness-gui", accountId: "acct-1" }],
  selectedScopeId: "team-1",
  selectedProjectId: "proj-1",
  harnessTeamKey: "ENG",
  githubDispatch: {
    eligible: true,
    source: "saved-github-token",
    repository: "weston-uribe/agentic-product-development-harness",
    message:
      "Saved GITHUB_TOKEN can dispatch to weston-uribe/agentic-product-development-harness.",
  },
  capabilities: {
    teamCreate: true,
    projectCreate: true,
  },
};

function observabilityFilePath(): string {
  const workspaceDir = resolveWorkspaceDir();
  if (!workspaceDir) {
    throw new Error("Configure browser workspace path is not available.");
  }
  return path.join(workspaceDir, ".harness/observability.local.json");
}

function setDisclosureShown(shown: boolean): void {
  const filePath = observabilityFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      shown
        ? {
            schemaVersion: 1,
            analyticsPreference: "disabled",
            errorReportingPreference: "disabled",
            disclosureShown: true,
          }
        : {
            schemaVersion: 1,
            analyticsPreference: null,
            errorReportingPreference: null,
            disclosureShown: false,
          },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function mockConfigureApis(page: Page): Promise<void> {
  await page.route("**/api/setup/vercel-bridge-options**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(VERCEL_BRIDGE_OPTIONS),
    });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  expect(overflow).toBe(false);
}

async function openSettingsMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test.describe("configure browser matrix", () => {
  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true });
  });

  test.describe("data sharing gate", () => {
    test.beforeEach(() => {
      setDisclosureShown(false);
    });

    test("blocks setup until continue succeeds", async ({ page }) => {
      await page.goto("/settings/configure");

      await expect(page.getByText(/^Data sharing$/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toHaveCount(0);
      await expect(page.getByText(/Step 1 of 7/)).toHaveCount(0);

      await page.getByRole("button", { name: "Continue setup" }).click();

      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toBeVisible();
      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible();
    });

    test("supports keyboard continue setup", async ({ page }) => {
      await page.goto("/settings/configure");
      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Continue setup" }).focus();
      await page.keyboard.press("Enter");

      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible();
    });

    test("stays readable in dark theme", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/settings/configure");

      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });
      await assertNoHorizontalOverflow(page);
    });

    test("stays readable in light theme", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/settings/configure");

      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });
      await assertNoHorizontalOverflow(page);
    });

    test("remains usable with reduced motion", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/settings/configure");

      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Continue setup" }).click();
      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible();
    });

    test("unchecked continue persists disabled preferences locally", async ({ page }) => {
      await page.goto("/settings/configure");
      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Continue setup" }).click();
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toBeVisible();

      const persisted = JSON.parse(readFileSync(observabilityFilePath(), "utf8")) as {
        analyticsPreference: string;
        errorReportingPreference: string;
        disclosureShown: boolean;
      };
      expect(persisted.disclosureShown).toBe(true);
      expect(persisted.analyticsPreference).toBe("disabled");
      expect(persisted.errorReportingPreference).toBe("disabled");
    });

    test("failed save keeps the data sharing gate visible", async ({ page }) => {
      await page.route("**/api/observability/preferences", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({ status: 500, body: JSON.stringify({ error: "fail" }) });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings/configure");
      await expect(page.getByText(/^Data sharing$/)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Continue setup" }).click();

      await expect(page.getByText(/^Data sharing$/)).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toHaveCount(0);
      await expect(page.getByText(/Could not save data sharing preferences/i)).toBeVisible();
    });

    test("reload bypasses onboarding when disclosure was already shown", async ({ page }) => {
      setDisclosureShown(true);
      await page.goto("/settings/configure");
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^Data sharing$/)).toHaveCount(0);

      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toBeVisible();
      await expect(page.getByText(/^Data sharing$/)).toHaveCount(0);
    });
  });

  test.describe("guided configure flow", () => {
    test.beforeEach(() => {
      setDisclosureShown(true);
    });

    test("settings menu exposes data sharing from configure", async ({ page }) => {
      await mockConfigureApis(page);
      await page.goto("/settings/configure");
      await expect(
        page.getByRole("heading", { name: "Initial Harness Configuration" }),
      ).toBeVisible({ timeout: 30_000 });

      await openSettingsMenu(page);
      await page.getByRole("menuitem", { name: "Data sharing" }).click();

      await expect(page).toHaveURL(/\/settings\/data-sharing$/);
      await expect(page.getByText(/^Data sharing$/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    });

    test("step 3 shows dispatch eligibility and back navigation returns to step 2", async ({
      page,
    }) => {
      await mockConfigureApis(page);
      await page.goto("/settings/configure");

      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible({
        timeout: 30_000,
      });

      await expect(
        page.getByText(/Could not resolve the harness dispatch repository/i),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Back" }).click();

      await expect(
        page.getByText(/Step 2 of 7 · Set up Linear workspace/),
      ).toBeVisible();

      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toHaveCount(
        0,
      );

      await page.waitForTimeout(1_000);

      await expect(
        page.getByText(/Step 2 of 7 · Set up Linear workspace/),
      ).toBeVisible();
      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toHaveCount(
        0,
      );

      await page.getByRole("button", { name: "Continue to Vercel bridge" }).click();

      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Apply Vercel Settings" })).toBeVisible();

      await page.screenshot({
        path: `${screenshotDir}/configure-step3-back-desktop.png`,
        fullPage: true,
      });
    });

    test("mobile step 3 back navigation remains usable", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockConfigureApis(page);
      await page.goto("/settings/configure");

      await expect(page.getByText(/Step 3 of 7 · Configure Vercel settings/)).toBeVisible({
        timeout: 30_000,
      });

      await page.getByRole("button", { name: "Back" }).click();
      await expect(
        page.getByText(/Step 2 of 7 · Set up Linear workspace/),
      ).toBeVisible();

      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: `${screenshotDir}/configure-step3-back-mobile.png`,
        fullPage: true,
      });
    });
  });
});
