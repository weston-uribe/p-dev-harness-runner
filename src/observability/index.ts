export {
  beginObservabilitySession,
  captureAnalyticsEvent,
  captureProductError,
  addObservabilityBreadcrumb,
  flushObservability,
  shutdownObservability,
  getActiveObservabilitySession,
  getObservabilityNonce,
  readObservabilityPreferences,
  writeObservabilityPreferences,
  resetObservabilityState,
  releaseParentObservabilityOwnership,
  createObservabilityTestRecorder,
  installObservabilityUncaughtHandlers,
  isAnalyticsCaptureEnabled,
  isErrorReportingCaptureEnabled,
  registerAnalyticsAdapterFactory,
  registerErrorAdapterFactory,
} from "./facade.js";

export type {
  AnalyticsEvent,
  ConsentPreference,
  ObservabilityLocalState,
  ProductErrorCaptureInput,
  TypedBreadcrumb,
} from "./types.js";

export {
  trackFastToggleDisplayed,
  trackFastPreferenceChanged,
  trackModelAgentRunStarted,
  trackModelAgentRunCompleted,
  serializeRequestedModelParams,
} from "./model-analytics.js";

export type {
  BeginObservabilitySessionInput,
  ObservabilitySession,
} from "./facade.js";

export {
  createObservabilityHandoff,
  observabilityHandoffEnv,
  resolveObservabilityHandoff,
} from "./session-handoff.js";
export type { ObservabilityHandoff } from "./session-handoff.js";
export { OBSERVABILITY_LOCAL_FILE } from "./constants.js";
export { isObservabilityRuntimeEligible } from "./runtime-eligibility.js";
export {
  parseObservabilityPublicConfigJson,
  resolveObservabilityPublicConfigForPrepare,
  resolveTrackedObservabilityPublicConfigPath,
} from "./package-config.js";
