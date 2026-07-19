import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENT_NAMES,
  allowedAnalyticsPropertyKeysForEvent,
} from "../../src/observability/privacy-schema.js";
import {
  GUIDED_DISPLAY_STEP_IDS,
  guidedDisplayStepNumber,
} from "../../src/observability/analytics-schemas.js";
import {
  CONFIGURE_FUNNEL_STEP_FILTERS,
  CONFIGURE_FUNNEL_STEPS_1_4,
  CONFIGURE_FUNNEL_STEPS_5_8,
  POSTHOG_DASHBOARD_EXCLUDED_METRICS,
  POSTHOG_DASHBOARD_FILTER_PROPERTIES,
  POSTHOG_INTERPRETATION_MARKDOWN,
  POSTHOG_ONBOARDING_HEALTH_DASHBOARD_DESCRIPTION,
  POSTHOG_ONBOARDING_HEALTH_DASHBOARD_NAME,
  POSTHOG_ONBOARDING_HEALTH_DEFAULT_DATE_RANGE,
  POSTHOG_ONBOARDING_HEALTH_INSIGHTS,
  POSTHOG_ONBOARDING_HEALTH_OPTIONAL_SPLIT_FUNNEL_NAMES,
  POSTHOG_ONBOARDING_HEALTH_REQUIRED_INSIGHT_NAMES,
  assertDashboardContractUsesAllowlistedEvents,
  assertDashboardContractUsesAllowlistedProperties,
} from "../../src/observability/posthog-dashboard-contract.js";
import type { AnalyticsEvent } from "../../src/observability/types.js";

describe("posthog onboarding health dashboard contract", () => {
  it("matches the documented dashboard identity", () => {
    expect(POSTHOG_ONBOARDING_HEALTH_DASHBOARD_NAME).toBe(
      "p-dev Packaged Onboarding Health",
    );
    expect(POSTHOG_ONBOARDING_HEALTH_DASHBOARD_DESCRIPTION).toContain(
      "Consent-gated packaged product analytics",
    );
    expect(POSTHOG_ONBOARDING_HEALTH_DEFAULT_DATE_RANGE).toBe("-30d");
    expect(POSTHOG_DASHBOARD_FILTER_PROPERTIES).toEqual([
      "package_version",
      "release_sha",
      "os_family",
    ]);
  });

  it("documents the interpretation card copy", () => {
    expect(POSTHOG_INTERPRETATION_MARKDOWN).toContain("## Interpretation");
    expect(POSTHOG_INTERPRETATION_MARKDOWN).toContain(
      "affirmatively enabled analytics",
    );
    expect(POSTHOG_INTERPRETATION_MARKDOWN).toContain(
      "Do not calculate adoption or consent rates",
    );
  });

  it("requires the mandatory insight inventory exactly once", () => {
    const names = POSTHOG_ONBOARDING_HEALTH_INSIGHTS.map((insight) => insight.name);
    expect(names.filter((name) => name === "Interpretation")).toHaveLength(1);
    for (const requiredName of POSTHOG_ONBOARDING_HEALTH_REQUIRED_INSIGHT_NAMES) {
      expect(names.filter((name) => name === requiredName)).toHaveLength(1);
    }
  });

  it("defines configure funnel steps from GUIDED_DISPLAY_STEP_IDS in order", () => {
    expect(CONFIGURE_FUNNEL_STEP_FILTERS.map((step) => step.stepId)).toEqual([
      ...GUIDED_DISPLAY_STEP_IDS,
    ]);
    expect(CONFIGURE_FUNNEL_STEPS_1_4.map((step) => step.stepId)).toEqual(
      GUIDED_DISPLAY_STEP_IDS.slice(0, 4),
    );
    expect(CONFIGURE_FUNNEL_STEPS_5_8.map((step) => step.stepId)).toEqual(
      GUIDED_DISPLAY_STEP_IDS.slice(4),
    );
    for (const step of CONFIGURE_FUNNEL_STEP_FILTERS) {
      expect(step.completionOutcomes).toEqual(["success", "skipped_already_complete"]);
      expect(guidedDisplayStepNumber(step.stepId)).toBeGreaterThan(0);
    }
  });

  it("ends the setup funnel at p_dev_setup_completed", () => {
    const setupFunnel = POSTHOG_ONBOARDING_HEALTH_INSIGHTS.find(
      (insight) => insight.name === "Session to Setup Completion",
    );
    expect(setupFunnel?.events).toEqual([
      "p_dev_session_started",
      "p_dev_setup_completed",
    ]);
  });

  it("uses only allowlisted analytics events", () => {
    expect(() => assertDashboardContractUsesAllowlistedEvents()).not.toThrow();
    const used = new Set(
      POSTHOG_ONBOARDING_HEALTH_INSIGHTS.flatMap((insight) => insight.events),
    );
    for (const eventName of used) {
      expect(ANALYTICS_EVENT_NAMES).toContain(eventName);
    }
    expect(used.has("p_dev_configure_step_viewed")).toBe(false);
  });

  it("uses only allowlisted breakdown properties per event", () => {
    expect(() => assertDashboardContractUsesAllowlistedProperties()).not.toThrow();
    for (const insight of POSTHOG_ONBOARDING_HEALTH_INSIGHTS) {
      for (const eventName of insight.events) {
        const event = { type: eventName } as AnalyticsEvent;
        const allowed = new Set(allowedAnalyticsPropertyKeysForEvent(event));
        for (const property of [
          ...(insight.breakdownProperties ?? []),
          ...(insight.secondaryBreakdownProperties ?? []),
        ]) {
          expect(allowed.has(property)).toBe(true);
        }
      }
    }
  });

  it("excludes consent-rate metrics", () => {
    expect(POSTHOG_DASHBOARD_EXCLUDED_METRICS).toContain("consent_rate");
    const serialized = JSON.stringify(POSTHOG_ONBOARDING_HEALTH_INSIGHTS);
    expect(serialized).not.toMatch(/consent.?rate/i);
    expect(serialized).not.toMatch(/distinct_id/);
  });

  it("authorizes split configure funnels without omitting steps", () => {
    expect(POSTHOG_ONBOARDING_HEALTH_OPTIONAL_SPLIT_FUNNEL_NAMES).toEqual([
      "Configure Funnel — Steps 1–4",
      "Configure Funnel — Steps 5–8",
    ]);
    const combined = [
      ...CONFIGURE_FUNNEL_STEPS_1_4,
      ...CONFIGURE_FUNNEL_STEPS_5_8,
    ].map((step) => step.stepId);
    expect(combined).toEqual([...GUIDED_DISPLAY_STEP_IDS]);
  });
});
