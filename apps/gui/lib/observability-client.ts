"use client";

import type { ClientAnalyticsEvent } from "@harness/observability/analytics-schemas.js";

export async function postObservabilityAnalyticsEvent(
  event: ClientAnalyticsEvent,
  nonce: string,
): Promise<void> {
  const response = await fetch("/api/observability/event", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-p-dev-observability-nonce": nonce,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    return;
  }
}
