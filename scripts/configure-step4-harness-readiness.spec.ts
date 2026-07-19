import { test, expect } from "@playwright/test";

test.describe("configure step 4 harness readiness", () => {
  test("enables create local setup files without false harness verify prompts", async ({
    page,
  }) => {
    await page.route("**/api/setup/harness-provisioning-summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtimeMode: "source",
          eligible: false,
          state: "skipped-source-mode",
          harnessDispatchRepo: "weston-uribe/agentic-product-development-harness",
          authenticatedLogin: null,
          message:
            "Using harness workspace weston-uribe/agentic-product-development-harness from Step 1 setup.",
          recoverable: false,
          connectedAutomatically: false,
          verifiedSavedRepo: true,
        }),
      });
    });

    await page.route("**/api/setup/verify-target-repo", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "connected",
          message:
            "Connected to acme/example-target-app with repo + workflow install access.",
          repoSlug: "acme/example-target-app",
          workflowInstallReady: true,
        }),
      });
    });

    await page.goto("/settings/configure");

    await expect(
      page.getByText(/Step 4 of 7 · Choose target repo\(s\) and create setup files/),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      page.getByText(
        "Verify and use this harness repo before creating local setup files.",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "Verify and use your harness repo before creating local setup files.",
      ),
    ).toHaveCount(0);

    await page
      .getByPlaceholder("https://github.com/acme/my-product")
      .fill("https://github.com/acme/example-target-app");

    const verifyRepoButton = page.getByRole("button", {
      name: "Verify repo + workflow access",
    });
    if (await verifyRepoButton.isEnabled()) {
      await verifyRepoButton.click();
    }

    await expect(page.getByRole("button", { name: "Verified" })).toBeVisible();

    await page
      .getByRole("checkbox", {
        name: "I understand this will create local setup files on this machine.",
      })
      .check();

    await expect(
      page.getByRole("button", { name: "Create local setup files" }),
    ).toBeEnabled();
  });
});
