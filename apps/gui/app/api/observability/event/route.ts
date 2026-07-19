import { NextRequest, NextResponse } from "next/server";
import {
  captureAnalyticsEvent,
  registerDisplayedConfigureStep,
} from "@harness/observability/facade.js";
import {
  parseClientAnalyticsEventBody,
  toAnalyticsEvent,
} from "@harness/observability/analytics-schemas.js";
import { guardObservabilityRequest } from "@/lib/observability-request-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardObservabilityRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const event = parseClientAnalyticsEventBody(guard.body);
    if (
      event.type === "p_dev_configure_step_viewed" ||
      event.type === "p_dev_configure_step_completed"
    ) {
      registerDisplayedConfigureStep(event.stepId);
    }
    captureAnalyticsEvent(toAnalyticsEvent(event));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Invalid analytics event payload." },
      { status: 400 },
    );
  }
}
