import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeliveryDedupRecord {
  deliveryId: string;
  issueKey: string;
  runId: string;
  startedAt: string;
}

export interface DeliveryDedupResult {
  shouldSkip: boolean;
  reason?: string;
  existing?: DeliveryDedupRecord;
}

function sanitizeDeliveryId(deliveryId: string): string {
  return deliveryId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function getDeliveryDedupPath(
  logDirectory: string,
  deliveryId: string,
): string {
  return path.join(logDirectory, "delivery-dedup", `${sanitizeDeliveryId(deliveryId)}.json`);
}

export async function readDeliveryDedupRecord(
  logDirectory: string,
  deliveryId: string,
): Promise<DeliveryDedupRecord | null> {
  try {
    const raw = await readFile(getDeliveryDedupPath(logDirectory, deliveryId), "utf8");
    return JSON.parse(raw) as DeliveryDedupRecord;
  } catch {
    return null;
  }
}

export async function recordDeliveryStart(input: {
  logDirectory: string;
  deliveryId: string;
  issueKey: string;
  runId: string;
}): Promise<DeliveryDedupRecord> {
  const record: DeliveryDedupRecord = {
    deliveryId: input.deliveryId,
    issueKey: input.issueKey,
    runId: input.runId,
    startedAt: new Date().toISOString(),
  };
  const filePath = getDeliveryDedupPath(input.logDirectory, input.deliveryId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function checkDeliveryDedup(input: {
  logDirectory: string;
  deliveryId: string;
  runId: string;
  issueKey: string;
}): Promise<DeliveryDedupResult> {
  const existing = await readDeliveryDedupRecord(input.logDirectory, input.deliveryId);
  if (!existing) {
    return { shouldSkip: false };
  }

  if (existing.runId === input.runId) {
    return { shouldSkip: false, existing };
  }

  return {
    shouldSkip: true,
    reason: `delivery ${input.deliveryId} already started run ${existing.runId}`,
    existing,
  };
}
