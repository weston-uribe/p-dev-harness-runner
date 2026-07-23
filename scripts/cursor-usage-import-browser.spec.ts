import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const fixtureCsv = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/cursor-usage/sample-usage.csv",
);

const FAKE_LANGFUSE = "http://127.0.0.1:18999";

const CSV_HEADER =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";

function browserWorkspace(): string {
  const fromEnv = process.env.CURSOR_USAGE_BROWSER_WORKSPACE?.trim();
  if (fromEnv) return fromEnv;
  return readFileSync("/tmp/cursor-usage-browser-workspace.txt", "utf8").trim();
}

async function resetFakeLangfuse(
  scenario:
    | "default"
    | "cut_through"
    | "unmatched_extra"
    | "ambiguous"
    | "model_conflict"
    | "variant_conflict"
    | "unknown_pricing"
    | "multi_page" = "default",
): Promise<void> {
  await fetch(`${FAKE_LANGFUSE}/__test__/reset`, { method: "POST" });
  if (scenario !== "default") {
    await fetch(`${FAKE_LANGFUSE}/__test__/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
  }
}

async function fakeRequestCounts(): Promise<{
  traceListRequests: number;
  observationRequests: number;
  windowObservationRequests: number;
  perTraceObservationRequests: number;
}> {
  const res = await fetch(`${FAKE_LANGFUSE}/__test__/request-counts`);
  return (await res.json()) as {
    traceListRequests: number;
    observationRequests: number;
    windowObservationRequests: number;
    perTraceObservationRequests: number;
  };
}

/** Wipe only this suite's workspace import artifacts (no production delete route). */
function resetOperatorWorkspaceImports(): void {
  const workspace = browserWorkspace();
  const importsDir = path.join(
    workspace,
    "runs/evaluation-reports/cursor-usage-imports",
  );
  rmSync(importsDir, { recursive: true, force: true });
}

async function scoreCreateCount(): Promise<number> {
  const res = await fetch(`${FAKE_LANGFUSE}/__test__/score-creates`);
  const body = (await res.json()) as { count: number };
  return body.count;
}

function writeTempCsv(name: string, body: string): string {
  const dir = path.join(tmpdir(), `cursor-usage-e2e-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

async function runPreflight(
  page: import("@playwright/test").Page,
  csvPath: string,
  exportStart?: string,
  exportEnd?: string,
): Promise<void> {
  await page.goto("/settings/cursor-usage");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    sessionStorage.removeItem("cursor-usage-import-id");
  });
  await page.getByTestId("cursor-usage-file-input").setInputFiles(csvPath);
  await expect(page.getByTestId("cursor-usage-source-summary")).toBeVisible({
    timeout: 30_000,
  });
  if (exportStart != null && exportEnd != null) {
    await page.getByTestId("cursor-usage-advanced-override").check();
    await page.getByTestId("cursor-usage-export-start").fill(exportStart);
    await page.getByTestId("cursor-usage-export-end").fill(exportEnd);
  } else {
    await expect(page.getByTestId("cursor-usage-export-start")).not.toHaveValue(
      "",
    );
    await expect(page.getByTestId("cursor-usage-export-end")).not.toHaveValue(
      "",
    );
  }
  await page.getByTestId("cursor-usage-preflight-button").click();
  await expect(page.getByTestId("cursor-usage-preflight-panel")).toBeVisible({
    timeout: 90_000,
  });
}

test.describe("cursor usage import browser", () => {
  test.beforeEach(async () => {
    resetOperatorWorkspaceImports();
    await resetFakeLangfuse("default");
  });

  test("shows isolated discovery config and never contacts cloud Langfuse", async ({
    page,
  }) => {
    const nonLoopbackLangfuse: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (/langfuse\.com/i.test(url) || /cloud\.langfuse/i.test(url)) {
        nonLoopbackLangfuse.push(url);
      }
    });
    await page.goto("/settings/cursor-usage");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("cursor-usage-langfuse-configured")).toHaveText(
      "yes",
    );
    await expect(page.getByTestId("cursor-usage-config-namespace")).toHaveText(
      "default",
    );
    await expect(page.getByTestId("cursor-usage-config-environment")).toHaveText(
      "All environments",
    );
    await expect(page.getByTestId("cursor-usage-config-host")).toHaveText(
      "127.0.0.1",
    );
    const visible = await page.getByTestId("cursor-usage-page").innerText();
    expect(visible).not.toContain("pk-");
    expect(visible).not.toContain("sk-");
    expect(visible).not.toContain("us.cloud.langfuse.com");
    expect(nonLoopbackLangfuse).toEqual([]);
  });

  test("multi-page discovery performs one invocation with page-sized trace lists", async ({
    page,
  }) => {
    await resetFakeLangfuse("multi_page");
    const before = await fakeRequestCounts();
    await runPreflight(page, fixtureCsv);
    await expect(page.getByTestId("cursor-usage-preflight-panel")).toBeVisible({
      timeout: 60_000,
    });
    const afterPreflight = await fakeRequestCounts();
    const traceLists =
      afterPreflight.traceListRequests - before.traceListRequests;
    // multi_page forces page size 1 across 2 fixture traces → 2 list calls for one invocation.
    expect(traceLists).toBeGreaterThanOrEqual(2);
    expect(traceLists).toBeLessThanOrEqual(2);
    expect(afterPreflight.observationRequests - before.observationRequests).toBeGreaterThan(0);
    expect(
      afterPreflight.windowObservationRequests - before.windowObservationRequests,
    ).toBeGreaterThan(0);
    expect(
      afterPreflight.perTraceObservationRequests -
        before.perTraceObservationRequests,
    ).toBe(0);

    // Table already rendered; no additional discovery traffic.
    await expect(page.getByTestId("cursor-usage-preflight-table")).toBeVisible();
    const afterRender = await fakeRequestCounts();
    expect(afterRender.traceListRequests).toBe(afterPreflight.traceListRequests);
    expect(afterRender.observationRequests).toBe(
      afterPreflight.observationRequests,
    );
    expect(afterRender.perTraceObservationRequests).toBe(
      afterPreflight.perTraceObservationRequests,
    );

    await expect(page.getByTestId("diag-traces-fetched")).toBeVisible();
    const body = await page.content();
    expect(body).not.toContain("bc-agent-planning-001");
  });

  test("newest-first CSV auto-populates observed window start < end", async ({
    page,
  }) => {
    const newestFirst = writeTempCsv(
      "newest-first.csv",
      [
        CSV_HEADER,
        "2026-07-22T16:47:19.615Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
        "2026-07-16T01:27:44.299Z,,,Included,composer-2.5,false,10,20,30,5,65,Included",
        "2026-07-16T01:27:44.299Z,bc-agent-planreview-001,,Included,composer-2.5,false,50,100,200,40,390,Included",
      ].join("\n"),
    );
    await page.goto("/settings/cursor-usage");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("cursor-usage-file-input").setInputFiles(newestFirst);
    await expect(page.getByTestId("cursor-usage-source-summary")).toBeVisible({
      timeout: 30_000,
    });
    const start = await page.getByTestId("cursor-usage-export-start").inputValue();
    const end = await page.getByTestId("cursor-usage-export-end").inputValue();
    expect(start < end).toBe(true);
    await expect(page.getByTestId("cursor-usage-timezone-evidence")).toContainText(
      "UTC",
    );
    await expect(page.getByTestId("cursor-usage-attributable-count")).toHaveText(
      "2",
    );
    await expect(page.getByTestId("cursor-usage-excluded-count")).toHaveText("1");
    await expect(page.getByTestId("cursor-usage-cache-write-summary")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-cache-read-summary")).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("bc-agent-planning-001");
    expect(html).not.toContain("bc-agent-planreview-001");
  });

  test("happy path: bulk CSV import stays secret-safe and duplicate-click safe", async ({
    page,
  }) => {
    await runPreflight(page, fixtureCsv);
    await expect(page.getByTestId("cursor-usage-preflight-table")).toBeVisible();
    await expect(page.getByTestId("preflight-state-matched").first()).toBeVisible();

    const applyButton = page.getByTestId("cursor-usage-apply-button");
    await expect(applyButton).toBeDisabled();
    await page.getByTestId("cursor-usage-apply-confirm").check();
    await expect(applyButton).toBeEnabled();

    await Promise.all([applyButton.click(), applyButton.click()]);
    await expect(page.getByTestId("cursor-usage-lifecycle")).toHaveText(
      "verified",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("cursor-usage-verified")).toHaveText("yes");
    await expect(applyButton).toBeDisabled();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("cursor-usage-results-panel")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-analytics-panel")).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-langfuse-status"),
    ).toContainText("Not run");

    const visible = await page.getByTestId("cursor-usage-page").innerText();
    expect(visible).not.toMatch(/\bsk-[a-z0-9_-]{8,}\b/i);
    expect(visible).not.toMatch(/\bpk-[a-z0-9_-]{8,}\b/i);
    expect(visible).not.toContain("bc-agent-planning-001");
    expect(visible).not.toContain("bc-agent-planreview-001");
  });

  test("cut-through export: Apply disabled and zero score-creates", async ({
    page,
  }) => {
    await resetFakeLangfuse("cut_through");
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T10:00:00.000Z",
      "2026-07-19T14:00:00.000Z",
    );
    await expect(page.getByTestId("cursor-usage-source-incomplete")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    expect(await scoreCreateCount()).toBe(before);
  });

  test("matched + unmatched agent: incomplete, zero score-creates", async ({
    page,
  }) => {
    await resetFakeLangfuse("unmatched_extra");
    const csv = writeTempCsv(
      "unmatched.csv",
      [
        CSV_HEADER,
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
        "2026-07-19T12:30:00.000Z,bc-agent-unknown-999,,Included,composer-2.5,false,10,20,30,5,65,Included",
      ].join("\n"),
    );
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      csv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    await expect(page.getByTestId("cursor-usage-source-incomplete")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    expect(await scoreCreateCount()).toBe(before);
  });

  test("ambiguous mapping: Apply disabled, zero score-creates", async ({
    page,
  }) => {
    await resetFakeLangfuse("ambiguous");
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    expect(await scoreCreateCount()).toBe(before);
  });

  test("model conflict: incomplete copy, zero score-creates", async ({
    page,
  }) => {
    await resetFakeLangfuse("model_conflict");
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    await expect(page.getByTestId("cursor-usage-source-incomplete")).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-model-conflict-copy"),
    ).toBeVisible();
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    expect(await scoreCreateCount()).toBe(before);
  });

  test("variant conflict: incomplete, zero score-creates", async ({ page }) => {
    await resetFakeLangfuse("variant_conflict");
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    await expect(page.getByTestId("cursor-usage-source-incomplete")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    expect(await scoreCreateCount()).toBe(before);
  });

  test("unknown pricing: tokens-only apply, pricing-incomplete analytics", async ({
    page,
  }) => {
    await resetFakeLangfuse("unknown_pricing");
    const before = await scoreCreateCount();
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    const applyButton = page.getByTestId("cursor-usage-apply-button");
    await page.getByTestId("cursor-usage-apply-confirm").check();
    await expect(applyButton).toBeEnabled();
    await applyButton.click();
    await expect(page.getByTestId("cursor-usage-lifecycle")).toHaveText(
      "verified",
      { timeout: 60_000 },
    );
    const created = (await scoreCreateCount()) - before;
    // Two phases × 12 token/boolean scores; numeric USD cost totals omitted.
    expect(created).toBe(24);
    const createsRes = await fetch(`${FAKE_LANGFUSE}/__test__/score-creates`);
    const createsBody = (await createsRes.json()) as {
      events: Array<{ name?: string }>;
    };
    const names = createsBody.events.map((e) => String(e.name ?? ""));
    expect(names.some((n) => n.includes("cost_usd"))).toBe(false);
    expect(names).not.toContain("cursor_provider_actual_usd");
    await expect(
      page.getByTestId("cursor-usage-analytics-pricing-incomplete"),
    ).toBeVisible();
    const incompleteText = await page
      .getByTestId("cursor-usage-analytics-pricing-incomplete")
      .innerText();
    expect(Number.parseInt(incompleteText, 10)).toBeGreaterThan(0);
  });

  test("upload-scoped rejection (invalid nonblank agent id): blocks apply, zero score-creates", async ({
    page,
  }) => {
    await resetFakeLangfuse("default");
    const csv = writeTempCsv(
      "bad-agent.csv",
      [
        CSV_HEADER,
        "2026-07-19T12:00:00.000Z,not-a-bc-id,,Included,composer-2.5,false,100,200,300,50,650,Included",
      ].join("\n"),
    );
    const before = await scoreCreateCount();
    await runPreflight(page, csv);
    await expect(page.getByTestId("cursor-usage-rejection-summary")).toBeVisible();
    await expect(page.getByTestId("cursor-usage-apply-button")).toBeDisabled();
    const summary = await page
      .getByTestId("cursor-usage-rejection-summary")
      .innerText();
    expect(summary).toMatch(/upload-scoped:\s*[1-9]/);
    expect(summary).not.toContain("not-a-bc-id");
    expect(summary).not.toContain("Included,composer");
    expect(await scoreCreateCount()).toBe(before);
  });

  test("analytics shows grouped issue/phase/model/variant/digest after verified import", async ({
    page,
  }) => {
    // beforeEach already emptied the workspace; preserve this scenario's import across reload.
    await resetFakeLangfuse("default");
    await runPreflight(
      page,
      fixtureCsv,
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T23:59:59.000Z",
    );
    await page.getByTestId("cursor-usage-apply-confirm").check();
    await page.getByTestId("cursor-usage-apply-button").click();
    await expect(page.getByTestId("cursor-usage-lifecycle")).toHaveText(
      "verified",
      { timeout: 60_000 },
    );

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("cursor-usage-analytics-panel")).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-langfuse-status"),
    ).toContainText("Not run");
    await expect(
      page.getByTestId("cursor-usage-analytics-by-issue"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-by-phase"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-by-source-model"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-by-variant"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-by-source-digest"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cursor-usage-analytics-by-pricing-registry"),
    ).toBeVisible();
  });
});
