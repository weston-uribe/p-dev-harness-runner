import {
  ANALYTICS_EVENT_NAMES,
  allowedAnalyticsPropertyKeysForEvent,
} from "./privacy-schema.js";
import {
  GUIDED_DISPLAY_STEP_IDS,
  guidedDisplayStepNumber,
} from "./analytics-schemas.js";
import { OBSERVABILITY_SCHEMA_VERSION } from "./constants.js";
import type { AnalyticsEvent } from "./types.js";

export const POSTHOG_ONBOARDING_HEALTH_DASHBOARD_NAME =
  "p-dev Packaged Onboarding Health" as const;

export const POSTHOG_ONBOARDING_HEALTH_DASHBOARD_DESCRIPTION =
  "Consent-gated packaged product analytics for p-dev-harness onboarding and workspace provisioning. Only installations that affirmatively enable anonymous analytics are visible. Counts must not be interpreted as total installs, and this dashboard must not be used to calculate a consent rate." as const;

export const POSTHOG_ONBOARDING_HEALTH_DEFAULT_DATE_RANGE = "-30d" as const;

export const POSTHOG_DASHBOARD_FILTER_PROPERTIES = [
  "package_version",
  "release_sha",
  "os_family",
] as const;

export const POSTHOG_DASHBOARD_EXCLUDED_METRICS = [
  "consent_rate",
  "analytics_opt_in_rate",
  "error_reporting_opt_in_rate",
] as const;

export const POSTHOG_INTERPRETATION_MARKDOWN = `## Interpretation

This dashboard contains only anonymous product analytics from packaged p-dev-harness installations that affirmatively enabled analytics.

Non-consenting installations are intentionally invisible. Do not calculate adoption or consent rates from this data.

Use package_version and release_sha to compare releases. Telemetry is supporting evidence, not an authoritative trigger for releases, security actions, or product decisions.`;

export const CONFIGURE_FUNNEL_SUCCESS_OUTCOMES = [
  "success",
  "skipped_already_complete",
] as const;

export type PostHogDashboardInsightKind =
  | "text"
  | "trends"
  | "funnel"
  | "breakdown";

export interface PostHogDashboardInsightSpec {
  name: string;
  kind: PostHogDashboardInsightKind;
  events: readonly (typeof ANALYTICS_EVENT_NAMES)[number][];
  breakdownProperties?: readonly string[];
  secondaryBreakdownProperties?: readonly string[];
  display?: "line" | "bar" | "stacked_bar" | "table";
  funnelStepFilters?: readonly ConfigureFunnelStepFilter[];
}

export interface ConfigureFunnelStepFilter {
  stepId: (typeof GUIDED_DISPLAY_STEP_IDS)[number];
  completionOutcomes: readonly (typeof CONFIGURE_FUNNEL_SUCCESS_OUTCOMES)[number][];
}

function configureStepFilter(
  stepId: (typeof GUIDED_DISPLAY_STEP_IDS)[number],
): ConfigureFunnelStepFilter {
  return {
    stepId,
    completionOutcomes: CONFIGURE_FUNNEL_SUCCESS_OUTCOMES,
  };
}

export const CONFIGURE_FUNNEL_STEP_FILTERS: readonly ConfigureFunnelStepFilter[] =
  GUIDED_DISPLAY_STEP_IDS.map(configureStepFilter);

export const CONFIGURE_FUNNEL_STEPS_1_4: readonly ConfigureFunnelStepFilter[] =
  CONFIGURE_FUNNEL_STEP_FILTERS.slice(0, 4);

export const CONFIGURE_FUNNEL_STEPS_5_8: readonly ConfigureFunnelStepFilter[] =
  CONFIGURE_FUNNEL_STEP_FILTERS.slice(4);

export const POSTHOG_ONBOARDING_HEALTH_INSIGHTS: readonly PostHogDashboardInsightSpec[] =
  [
    {
      name: "Interpretation",
      kind: "text",
      events: [],
    },
    {
      name: "Packaged Sessions by Release",
      kind: "trends",
      events: ["p_dev_session_started"],
      breakdownProperties: ["package_version"],
      display: "line",
    },
    {
      name: "Packaged Sessions by OS",
      kind: "trends",
      events: ["p_dev_session_started"],
      breakdownProperties: ["os_family"],
      display: "bar",
    },
    {
      name: "Session to Setup Completion",
      kind: "funnel",
      events: ["p_dev_session_started", "p_dev_setup_completed"],
      breakdownProperties: ["package_version"],
    },
    {
      name: "Configure Step Completion Funnel",
      kind: "funnel",
      events: ["p_dev_configure_step_completed"],
      funnelStepFilters: CONFIGURE_FUNNEL_STEP_FILTERS,
    },
    {
      name: "Configure Funnel — Steps 1–4",
      kind: "funnel",
      events: ["p_dev_configure_step_completed"],
      funnelStepFilters: CONFIGURE_FUNNEL_STEPS_1_4,
    },
    {
      name: "Configure Funnel — Steps 5–8",
      kind: "funnel",
      events: ["p_dev_configure_step_completed"],
      funnelStepFilters: CONFIGURE_FUNNEL_STEPS_5_8,
    },
    {
      name: "Configure Outcomes by Step",
      kind: "breakdown",
      events: ["p_dev_configure_step_completed"],
      breakdownProperties: ["step_id"],
      secondaryBreakdownProperties: ["completion_outcome"],
      display: "stacked_bar",
    },
    {
      name: "Workspace Provisioning Outcomes",
      kind: "trends",
      events: [
        "p_dev_workspace_provision_started",
        "p_dev_workspace_provision_completed",
        "p_dev_workspace_provision_failed",
      ],
      breakdownProperties: ["package_version"],
      display: "line",
    },
    {
      name: "Provisioning Failure Categories",
      kind: "breakdown",
      events: ["p_dev_workspace_provision_failed"],
      breakdownProperties: ["failure_category"],
      display: "bar",
    },
    {
      name: "Provisioning Duration Buckets",
      kind: "breakdown",
      events: [
        "p_dev_workspace_provision_completed",
        "p_dev_workspace_provision_failed",
      ],
      breakdownProperties: ["duration_bucket"],
      display: "bar",
    },
    {
      name: "Provisioning Retry Buckets",
      kind: "breakdown",
      events: [
        "p_dev_workspace_provision_completed",
        "p_dev_workspace_provision_failed",
      ],
      breakdownProperties: ["retry_count_bucket"],
      display: "bar",
    },
    {
      name: "Rate-Limit Pause Buckets",
      kind: "breakdown",
      events: [
        "p_dev_workspace_provision_completed",
        "p_dev_workspace_provision_failed",
      ],
      breakdownProperties: ["rate_limit_pause_count_bucket"],
      display: "bar",
    },
  ] as const;

export const POSTHOG_ONBOARDING_HEALTH_REQUIRED_INSIGHT_NAMES =
  POSTHOG_ONBOARDING_HEALTH_INSIGHTS.filter((insight) => insight.kind !== "text")
    .filter(
      (insight) =>
        insight.name !== "Configure Funnel — Steps 1–4" &&
        insight.name !== "Configure Funnel — Steps 5–8",
    )
    .map((insight) => insight.name);

export const POSTHOG_ONBOARDING_HEALTH_OPTIONAL_SPLIT_FUNNEL_NAMES = [
  "Configure Funnel — Steps 1–4",
  "Configure Funnel — Steps 5–8",
] as const;

export function assertDashboardContractUsesAllowlistedEvents(): void {
  const allowed = new Set<string>(ANALYTICS_EVENT_NAMES);
  for (const insight of POSTHOG_ONBOARDING_HEALTH_INSIGHTS) {
    for (const eventName of insight.events) {
      if (!allowed.has(eventName)) {
        throw new Error(`Dashboard insight "${insight.name}" uses unknown event.`);
      }
    }
  }
}

export function assertDashboardContractUsesAllowlistedProperties(): void {
  for (const insight of POSTHOG_ONBOARDING_HEALTH_INSIGHTS) {
    for (const eventName of insight.events) {
      const event = { type: eventName } as AnalyticsEvent;
      const allowed = new Set(allowedAnalyticsPropertyKeysForEvent(event));
      for (const property of [
        ...(insight.breakdownProperties ?? []),
        ...(insight.secondaryBreakdownProperties ?? []),
      ]) {
        if (!allowed.has(property)) {
          throw new Error(
            `Dashboard insight "${insight.name}" uses disallowed property "${property}".`,
          );
        }
      }
    }
  }
}

export function configureFunnelStepNumber(
  stepId: (typeof GUIDED_DISPLAY_STEP_IDS)[number],
): number {
  return guidedDisplayStepNumber(stepId);
}

export const POSTHOG_DASHBOARD_SCHEMA_VERSION = OBSERVABILITY_SCHEMA_VERSION;

export function configureStepEventProperties(
  stepId: (typeof GUIDED_DISPLAY_STEP_IDS)[number],
): Array<{
  key: string;
  type: "event";
  operator: "exact";
  value: string[];
}> {
  return [
    {
      key: "step_id",
      type: "event",
      operator: "exact",
      value: [stepId],
    },
    {
      key: "completion_outcome",
      type: "event",
      operator: "exact",
      value: [...CONFIGURE_FUNNEL_SUCCESS_OUTCOMES],
    },
  ];
}

export function buildConfigureFunnelSeries(
  steps: readonly ConfigureFunnelStepFilter[],
): Array<{
  kind: "EventsNode";
  event: "p_dev_configure_step_completed";
  name: string;
  properties: ReturnType<typeof configureStepEventProperties>;
}> {
  return steps.map((step) => ({
    kind: "EventsNode" as const,
    event: "p_dev_configure_step_completed" as const,
    name: step.stepId,
    properties: configureStepEventProperties(step.stepId),
  }));
}
