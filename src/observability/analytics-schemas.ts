import { z } from "zod";
import type { AnalyticsEvent, CompletionOutcome, DurationBucket } from "./types.js";

export const GUIDED_DISPLAY_STEP_IDS = [
  "connect-services",
  "linear-workspace",
  "vercel-bridge",
  "choose-target-repos",
  "local-readiness",
  "cloud-secrets",
  "target-workflow",
  "ready-for-first-run",
] as const;

export type GuidedDisplayStepId = (typeof GUIDED_DISPLAY_STEP_IDS)[number];

const guidedStepIdSchema = z.enum(GUIDED_DISPLAY_STEP_IDS);

const durationBucketSchema = z.enum([
  "lt_10s",
  "10s_30s",
  "30s_2m",
  "2m_5m",
  "gt_5m",
  "lt_1m",
  "1m_3m",
  "3m_10m",
  "gt_10m",
  "unknown",
] as const);

const completionOutcomeSchema = z.enum([
  "success",
  "skipped_already_complete",
  "user_correctable_blocked",
  "operational_failure",
  "unknown",
] as const);

const finiteStepNumberSchema = z
  .number()
  .int("stepNumber must be an integer")
  .finite("stepNumber must be finite");

export function guidedDisplayStepNumber(stepId: GuidedDisplayStepId): number {
  return GUIDED_DISPLAY_STEP_IDS.indexOf(stepId) + 1;
}

function assertExpectedStepNumber(
  stepId: GuidedDisplayStepId,
  stepNumber: number,
): void {
  const expected = guidedDisplayStepNumber(stepId);
  if (stepNumber !== expected) {
    throw new Error("Invalid analytics event payload.");
  }
}

const fixedResumeSchema = z.literal(false);

const stepViewedSchema = z
  .object({
    type: z.literal("p_dev_configure_step_viewed"),
    stepId: guidedStepIdSchema,
    stepNumber: finiteStepNumberSchema,
    resumed: fixedResumeSchema,
    revisited: fixedResumeSchema,
  })
  .strict();

const stepCompletedSchema = z
  .object({
    type: z.literal("p_dev_configure_step_completed"),
    stepId: guidedStepIdSchema,
    stepNumber: finiteStepNumberSchema,
    resumed: fixedResumeSchema,
    revisited: fixedResumeSchema,
    durationBucket: durationBucketSchema,
    completionOutcome: completionOutcomeSchema,
  })
  .strict();

const setupCompletedSchema = z
  .object({
    type: z.literal("p_dev_setup_completed"),
  })
  .strict();

const capabilitySourceSchema = z.enum([
  "cursor-live",
  "fixture",
  "fallback-registry",
  "unknown",
]);

const configurationSurfaceSchema = z.enum(["workflow", "settings"]);

const parameterEvidenceSourceSchema = z.enum([
  "stored",
  "harness_default_pin",
  "unsupported",
  "provider_default",
]);

const modelAnalyticsCommon = {
  agentRole: z.string().min(1).max(64),
  baseModelId: z.string().min(1).max(128),
  capabilitySource: capabilitySourceSchema,
  configurationSurface: configurationSurfaceSchema,
  parameterEvidenceSource: parameterEvidenceSourceSchema,
};

const fastToggleDisplayedSchema = z
  .object({
    type: z.literal("p_dev_model_fast_toggle_displayed"),
    ...modelAnalyticsCommon,
  })
  .strict();

const fastPreferenceChangedSchema = z
  .object({
    type: z.literal("p_dev_model_fast_preference_changed"),
    ...modelAnalyticsCommon,
    fastEnabled: z.boolean(),
  })
  .strict();

const clientAnalyticsEventSchema = z.union([
  stepViewedSchema,
  stepCompletedSchema,
  setupCompletedSchema,
  fastToggleDisplayedSchema,
  fastPreferenceChangedSchema,
]);

export type ClientAnalyticsEvent = z.infer<typeof clientAnalyticsEventSchema>;

const MAX_CLIENT_ANALYTICS_BODY_BYTES = 4_096;

export function parseClientAnalyticsEventBody(
  input: unknown,
): ClientAnalyticsEvent {
  if (typeof input === "string" && input.length > MAX_CLIENT_ANALYTICS_BODY_BYTES) {
    throw new Error("Analytics payload is too large.");
  }
  if (
    input !== null &&
    typeof input === "object" &&
    JSON.stringify(input).length > MAX_CLIENT_ANALYTICS_BODY_BYTES
  ) {
    throw new Error("Analytics payload is too large.");
  }

  const parsed = clientAnalyticsEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid analytics event payload.");
  }

  if (
    parsed.data.type === "p_dev_configure_step_viewed" ||
    parsed.data.type === "p_dev_configure_step_completed"
  ) {
    assertExpectedStepNumber(parsed.data.stepId, parsed.data.stepNumber);
  }

  return parsed.data;
}

export function toAnalyticsEvent(event: ClientAnalyticsEvent): AnalyticsEvent {
  if (event.type === "p_dev_configure_step_viewed") {
    return {
      type: event.type,
      stepId: event.stepId,
      stepNumber: event.stepNumber,
      resumed: event.resumed,
      revisited: event.revisited,
    };
  }
  if (event.type === "p_dev_configure_step_completed") {
    return {
      type: event.type,
      stepId: event.stepId,
      stepNumber: event.stepNumber,
      resumed: event.resumed,
      revisited: event.revisited,
      durationBucket: event.durationBucket as DurationBucket,
      completionOutcome: event.completionOutcome as CompletionOutcome,
    };
  }
  if (event.type === "p_dev_model_fast_toggle_displayed") {
    return {
      type: event.type,
      agentRole: event.agentRole,
      baseModelId: event.baseModelId,
      capabilitySource: event.capabilitySource,
      configurationSurface: event.configurationSurface,
      parameterEvidenceSource: event.parameterEvidenceSource,
    };
  }
  if (event.type === "p_dev_model_fast_preference_changed") {
    return {
      type: event.type,
      agentRole: event.agentRole,
      baseModelId: event.baseModelId,
      fastEnabled: event.fastEnabled,
      capabilitySource: event.capabilitySource,
      configurationSurface: event.configurationSurface,
      parameterEvidenceSource: event.parameterEvidenceSource,
    };
  }
  return { type: "p_dev_setup_completed" };
}
