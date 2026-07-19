import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDeliveryDedup,
  getDeliveryDedupPath,
  recordDeliveryStart,
} from "../../src/runner/delivery-dedup.js";

describe("delivery dedup", () => {
  it("allows one effective run per delivery id", async () => {
    const logDirectory = await mkdtemp(path.join(tmpdir(), "delivery-dedup-"));
    const deliveryId = "delivery-abc";

    const first = await checkDeliveryDedup({
      logDirectory,
      deliveryId,
      runId: "run-1",
      issueKey: "WES-1",
    });
    expect(first.shouldSkip).toBe(false);

    await recordDeliveryStart({
      logDirectory,
      deliveryId,
      runId: "run-1",
      issueKey: "WES-1",
    });

    const duplicate = await checkDeliveryDedup({
      logDirectory,
      deliveryId,
      runId: "run-2",
      issueKey: "WES-1",
    });
    expect(duplicate.shouldSkip).toBe(true);
    expect(duplicate.existing?.runId).toBe("run-1");

    const sameRunRetry = await checkDeliveryDedup({
      logDirectory,
      deliveryId,
      runId: "run-1",
      issueKey: "WES-1",
    });
    expect(sameRunRetry.shouldSkip).toBe(false);

    const raw = await readFile(getDeliveryDedupPath(logDirectory, deliveryId), "utf8");
    expect(JSON.parse(raw).runId).toBe("run-1");

    await rm(logDirectory, { recursive: true, force: true });
  });
});
