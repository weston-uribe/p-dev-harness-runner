import {
  P_DEV_ANALYTICS_DISABLED_ENV,
  P_DEV_OBSERVABILITY_DISABLED_ENV,
  P_DEV_SENTRY_DISABLED_ENV,
} from "./constants.js";
import type { ConsentPreference, EffectiveConsent } from "./types.js";

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isGlobalObservabilityDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnv(env.DO_NOT_TRACK) ||
    isTruthyEnv(env[P_DEV_OBSERVABILITY_DISABLED_ENV])
  );
}

export function isAnalyticsDisabledByEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isGlobalObservabilityDisabled(env) ||
    isTruthyEnv(env[P_DEV_ANALYTICS_DISABLED_ENV])
  );
}

export function isErrorReportingDisabledByEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isGlobalObservabilityDisabled(env) ||
    isTruthyEnv(env[P_DEV_SENTRY_DISABLED_ENV])
  );
}

export function resolveEffectiveConsent(input: {
  analyticsPreference: ConsentPreference;
  errorReportingPreference: ConsentPreference;
  env?: NodeJS.ProcessEnv;
}): EffectiveConsent {
  const env = input.env ?? process.env;
  const analyticsBlockedByEnvironment = isAnalyticsDisabledByEnvironment(env);
  const errorReportingBlockedByEnvironment =
    isErrorReportingDisabledByEnvironment(env);

  return {
    analyticsEnabled:
      !analyticsBlockedByEnvironment &&
      input.analyticsPreference === "enabled",
    errorReportingEnabled:
      !errorReportingBlockedByEnvironment &&
      input.errorReportingPreference === "enabled",
    analyticsBlockedByEnvironment,
    errorReportingBlockedByEnvironment,
  };
}

export function hasUndecidedConsent(input: {
  analyticsPreference: ConsentPreference;
  errorReportingPreference: ConsentPreference;
}): boolean {
  return (
    input.analyticsPreference === null &&
    input.errorReportingPreference === null
  );
}
