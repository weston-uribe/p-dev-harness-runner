import { createHash } from "node:crypto";

export interface JobRequestDedupeInput {
  issueKey: string;
  phase: string;
  linearDeliveryId?: string | null;
  triggerSource: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function computeJobRequestDedupeIdentity(
  input: JobRequestDedupeInput,
): string {
  const payload = {
    issueKey: input.issueKey.trim(),
    phase: input.phase.trim(),
    linearDeliveryId: input.linearDeliveryId?.trim() || null,
    triggerSource: input.triggerSource.trim(),
  };
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}
