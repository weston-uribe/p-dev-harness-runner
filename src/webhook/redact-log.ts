export interface WebhookLogFields {
  linearDeliveryId?: string | null;
  linearWebhookId?: string | null;
  /** Prefer requestId on public/bridge surfaces; issueKey is private-only. */
  requestId?: string | null;
  issueKey?: string | null;
  action?: string | null;
  statusName?: string | null;
  previousStatusName?: string | null;
  accepted?: boolean;
  dispatched?: boolean;
  reason?: string | null;
  error?: string | null;
}

export function logWebhookEvent(fields: WebhookLogFields): void {
  console.log(JSON.stringify({ event: "linear_webhook", ...fields }));
}

export function redactToken(value: string | null | undefined): string {
  if (!value) {
    return "[missing]";
  }
  if (value.length <= 8) {
    return "[redacted]";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
