import { createHash, randomUUID } from "node:crypto";

/**
 * Deterministic request id for Linear deliveries so duplicate webhooks
 * collide on create instead of spawning parallel envelopes.
 */
export function resolveJobRequestId(input: {
  linearDeliveryId?: string | null;
  requestId?: string;
}): string {
  if (input.requestId?.trim()) {
    return input.requestId.trim();
  }
  const delivery = input.linearDeliveryId?.trim();
  if (delivery) {
    const digest = createHash("sha256").update(delivery, "utf8").digest("hex");
    return `dlv-${digest.slice(0, 32)}`;
  }
  return randomUUID();
}
