import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHarnessDotenv } from "../../src/config/load-dotenv.js";

describe("loadHarnessDotenv", () => {
  let tempRoot = "";
  const envKeys = ["HARNESS_TEST_FROM_ENV", "HARNESS_TEST_FROM_LOCAL"];

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-load-dotenv-"));
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("loads .env.local and overrides .env values", async () => {
    await writeFile(
      path.join(tempRoot, ".env"),
      "HARNESS_TEST_FROM_ENV=from-env\nHARNESS_TEST_FROM_LOCAL=from-env\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "HARNESS_TEST_FROM_LOCAL=from-local\n",
      "utf8",
    );

    loadHarnessDotenv(tempRoot);

    expect(process.env.HARNESS_TEST_FROM_ENV).toBe("from-env");
    expect(process.env.HARNESS_TEST_FROM_LOCAL).toBe("from-local");
  });

  it("does not fail when .env.local is missing", async () => {
    await writeFile(
      path.join(tempRoot, ".env"),
      "HARNESS_TEST_FROM_ENV=from-env\n",
      "utf8",
    );

    expect(() => loadHarnessDotenv(tempRoot)).not.toThrow();
    expect(process.env.HARNESS_TEST_FROM_ENV).toBe("from-env");
  });

  it("does not fail when .env is missing", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "HARNESS_TEST_FROM_LOCAL=from-local\n",
      "utf8",
    );

    expect(() => loadHarnessDotenv(tempRoot)).not.toThrow();
    expect(process.env.HARNESS_TEST_FROM_LOCAL).toBe("from-local");
  });
});
