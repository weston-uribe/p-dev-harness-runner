import { expect, test } from "@playwright/test";

/**
 * Browser acceptance against the same operator launcher as `p-dev` / `npm start`.
 * Uses a new operator workspace (Configure entry) with disclosure already accepted.
 */
test.describe("operator GUI smoke", () => {
  test("primary pages style, navigate, and avoid module-loading 500s", async ({
    page,
  }) => {
    const failedAssets: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      if (
        url.includes("/_next/static/") &&
        (response.status() >= 400 || contentType.includes("text/html"))
      ) {
        failedAssets.push(`${response.status()} ${contentType} ${url}`);
      }
      if (
        url.includes("/api/setup/verify-saved-connections") &&
        response.status() >= 500
      ) {
        failedAssets.push(`${response.status()} ${url}`);
      }
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/settings\/configure/);
    await expect(page.locator("body")).toHaveAttribute(
      "data-p-dev-runtime-smoke",
      "1",
    );

    // Settings dropdown must open (client hydration / interactive shell).
    const settingsTrigger = page
      .getByRole("button", { name: /settings/i })
      .first();
    await expect(settingsTrigger).toBeVisible();
    await settingsTrigger.click();
    await expect(page.getByRole("menu", { name: /settings/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /mode/i })).toBeVisible();
    await page.keyboard.press("Escape");

    // Direct configure navigation + refresh
    await page.goto("/settings/configure");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toHaveAttribute(
      "data-p-dev-runtime-smoke",
      "1",
    );

    // New workspaces redirect Settings console routes back to Configure.
    await page.goto("/settings/connections");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/settings\/configure/);

    expect(failedAssets, failedAssets.join("\n")).toEqual([]);
    expect(
      pageErrors.filter((message) => /hydrat/i.test(message)),
      pageErrors.join("\n"),
    ).toEqual([]);
  });
});
