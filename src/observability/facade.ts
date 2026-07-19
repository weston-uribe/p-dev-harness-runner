import {
  OBSERVABILITY_FLUSH_DEADLINE_MS,
  P_DEV_OBSERVABILITY_NONCE_ENV,
} from "./constants.js";
import { resolveEffectiveConsent } from "./consent.js";
import { buildObservabilityContext } from "./context.js";
import { generateInstallationId } from "./identity.js";
import {
  isFirstLaunchForPDevHome,
  readObservabilityLocalState,
  resetObservabilityLocalState,
  updateObservabilityPreferences,
  type UpdateObservabilityPreferencesInput,
} from "./local-state.js";
import { readObservabilityPublicConfig } from "./package-config.js";
import { isObservabilityRuntimeEligible } from "./runtime-eligibility.js";
import {
  analyticsEventToProperties,
  allowedAnalyticsPropertyKeysForEvent,
  assertAllowedPropertyKeys,
} from "./privacy-schema.js";
import {
  guidedDisplayStepNumber,
  type GuidedDisplayStepId,
} from "./analytics-schemas.js";
import { resolveObservabilityHandoff } from "./session-handoff.js";
import {
  recordAnalyticsEventEmission,
  shouldDedupeAnalyticsEvent,
} from "./session-dedupe.js";
import {
  installObservabilityFatalHandlers,
  removeObservabilityFatalHandlers,
} from "./fatal-handlers.js";
import type {
  AllowedSentryContext,
  AnalyticsEvent,
  AnalyticsTransport,
  EffectiveConsent,
  ErrorTransport,
  FakeTransportRecorder,
  ObservabilityContext,
  ObservabilityLocalState,
  ProductErrorCaptureInput,
  SerializedAnalyticsEvent,
  TypedBreadcrumb,
  WorkspaceKind,
} from "./types.js";
import {
  createFakeAnalyticsTransport,
  createFakeErrorTransport,
  createFakeTransportRecorder,
} from "./adapters/fake.js";
import {
  getFacadeRuntimeState,
  resetFacadeRuntimeState,
} from "./facade-runtime-state.js";

function runtime() {
  return getFacadeRuntimeState();
}

export interface BeginObservabilitySessionInput {
  workspaceDir: string;
  workspaceKind?: WorkspaceKind;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  fakeRecorder?: FakeTransportRecorder;
}

export interface ObservabilitySession {
  workspaceDir: string;
  sessionId: string;
  nonce: string;
  context: ObservabilityContext;
  consent: EffectiveConsent;
  localState: ObservabilityLocalState;
  moduleUrl?: string;
}

let analyticsAdapterFactory: (() => AnalyticsTransport) | null = null;
let errorAdapterFactory:
  | ((input: {
      context: ObservabilityContext;
      moduleUrl?: string;
      env?: NodeJS.ProcessEnv;
    }) => ErrorTransport)
  | null = null;

export function registerAnalyticsAdapterFactory(
  factory: () => AnalyticsTransport,
): void {
  analyticsAdapterFactory = factory;
}

export function registerErrorAdapterFactory(
  factory: (input: {
    context: ObservabilityContext;
    moduleUrl?: string;
    env?: NodeJS.ProcessEnv;
  }) => ErrorTransport,
): void {
  errorAdapterFactory = factory;
}

export function registerDisplayedConfigureStep(stepId: GuidedDisplayStepId): void {
  runtime().displayedConfigureStepId = stepId;
}

export function registerProvisioningOperationId(operationId: string): void {
  runtime().activeProvisioningOperationId = operationId;
}

export function isAnalyticsCaptureEnabled(): boolean {
  const state = runtime();
  return (
    state.runtimeEligible &&
    !state.parentOwnershipReleased &&
    state.analyticsLifecycle.isCaptureEnabled() &&
    Boolean(state.activeSession?.consent.analyticsEnabled)
  );
}

export function isErrorReportingCaptureEnabled(): boolean {
  const state = runtime();
  return (
    state.runtimeEligible &&
    !state.parentOwnershipReleased &&
    state.errorLifecycle.isCaptureEnabled() &&
    Boolean(state.activeSession?.consent.errorReportingEnabled)
  );
}

function contextToCommonAnalyticsProperties(
  context: ObservabilityContext,
): Record<string, unknown> {
  if (!context.installationId) {
    throw new Error("Analytics requires an anonymous installation ID.");
  }
  return {
    observability_schema_version: context.observabilitySchemaVersion,
    package_version: context.packageVersion,
    release_sha: context.releaseSha,
    runtime_mode: context.runtimeMode,
    os_family: context.osFamily,
    cpu_arch_family: context.cpuArchFamily,
    node_major_version: context.nodeMajorVersion,
    session_id: context.sessionId,
    first_launch_for_p_dev_home: context.firstLaunchForPDevHome,
    workspace_kind: context.workspaceKind,
    distinct_id: context.installationId,
    $process_person_profile: false,
  };
}

function contextToSentryTags(
  context: ObservabilityContext,
  lifecyclePhase: AllowedSentryContext["lifecycle_phase"],
): AllowedSentryContext {
  return {
    observability_schema_version: context.observabilitySchemaVersion,
    package_version: context.packageVersion,
    release_sha: context.releaseSha,
    session_id: context.sessionId,
    runtime_mode: context.runtimeMode,
    os_family: context.osFamily,
    cpu_arch_family: context.cpuArchFamily,
    node_major_version: context.nodeMajorVersion,
    lifecycle_phase: lifecyclePhase,
  };
}

async function createAnalyticsAdapter(input: {
  fakeRecorder?: FakeTransportRecorder;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AnalyticsTransport | null> {
  if (input.fakeRecorder) {
    return createFakeAnalyticsTransport(input.fakeRecorder);
  }
  if (analyticsAdapterFactory) {
    return analyticsAdapterFactory();
  }
  const publicConfig = readObservabilityPublicConfig(
    input.moduleUrl,
    input.env,
  );
  if (publicConfig?.posthogProjectToken) {
    try {
      const { createPostHogAnalyticsTransport } = await import(
        "./adapters/posthog.js"
      );
      return createPostHogAnalyticsTransport({
        projectToken: publicConfig.posthogProjectToken,
        host: publicConfig.posthogIngestionHost,
      });
    } catch {
      return null;
    }
  }
  return null;
}

async function createErrorAdapter(input: {
  fakeRecorder?: FakeTransportRecorder;
  context: ObservabilityContext;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ErrorTransport | null> {
  if (input.fakeRecorder) {
    return createFakeErrorTransport(input.fakeRecorder);
  }
  if (errorAdapterFactory) {
    return errorAdapterFactory(input);
  }
  const publicConfig = readObservabilityPublicConfig(
    input.moduleUrl,
    input.env,
  );
  if (input.context && publicConfig?.sentryPublicDsn) {
    try {
      const { createSentryErrorTransport } = await import("./adapters/sentry.js");
      return createSentryErrorTransport({
        dsn: publicConfig.sentryPublicDsn,
        release: `p-dev-harness@${input.context.packageVersion}`,
      });
    } catch {
      return null;
    }
  }
  return null;
}

async function syncAnalyticsTransport(input: {
  consent: EffectiveConsent;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  fakeRecorder?: FakeTransportRecorder;
}): Promise<void> {
  const { analyticsLifecycle } = runtime();
  if (!input.consent.analyticsEnabled) {
    await analyticsLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    return;
  }
  const adapter = await createAnalyticsAdapter(input);
  if (!adapter) {
    await analyticsLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    return;
  }
  await analyticsLifecycle.enable(() => adapter);
}

async function syncErrorTransport(input: {
  consent: EffectiveConsent;
  context: ObservabilityContext;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  fakeRecorder?: FakeTransportRecorder;
}): Promise<void> {
  const { errorLifecycle } = runtime();
  if (!input.consent.errorReportingEnabled) {
    await errorLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    return;
  }
  const adapter = await createErrorAdapter(input);
  if (!adapter) {
    await errorLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    return;
  }
  await errorLifecycle.enable(() => adapter);
}

async function configureTransports(input: {
  consent: EffectiveConsent;
  context: ObservabilityContext;
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  fakeRecorder?: FakeTransportRecorder;
  analyticsOnly?: boolean;
  errorOnly?: boolean;
}): Promise<void> {
  if (!input.analyticsOnly && !input.errorOnly) {
    await Promise.all([
      syncAnalyticsTransport(input),
      syncErrorTransport(input),
    ]);
    return;
  }
  if (input.analyticsOnly) {
    await syncAnalyticsTransport(input);
    return;
  }
  if (input.errorOnly) {
    await syncErrorTransport(input);
  }
}

function emitSessionStartedIfNeeded(): void {
  const state = runtime();
  if (!state.activeSession || !isAnalyticsCaptureEnabled()) {
    return;
  }
  const event: AnalyticsEvent = { type: "p_dev_session_started" };
  if (
    shouldDedupeAnalyticsEvent(state.activeSession.sessionId, event)
  ) {
    return;
  }
  captureAnalyticsEvent(event);
}

function emitDisplayedConfigureStepViewIfNeeded(): void {
  const state = runtime();
  if (!state.activeSession || !state.displayedConfigureStepId || !isAnalyticsCaptureEnabled()) {
    return;
  }
  const stepId = state.displayedConfigureStepId;
  captureAnalyticsEvent({
    type: "p_dev_configure_step_viewed",
    stepId,
    stepNumber: guidedDisplayStepNumber(stepId),
    resumed: false,
    revisited: false,
  });
}

export async function beginObservabilitySession(
  input: BeginObservabilitySessionInput,
): Promise<ObservabilitySession | null> {
  const env = input.env ?? process.env;
  const state = runtime();
  state.parentOwnershipReleased = false;
  state.runtimeEligible = isObservabilityRuntimeEligible({
    env,
    allowFakeTransport: Boolean(input.fakeRecorder),
  });

  if (!state.runtimeEligible) {
    state.activeSession = null;
    state.activeFakeRecorder = undefined;
    await Promise.all([
      state.analyticsLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
      state.errorLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
    ]);
    return null;
  }

  const localState = await readObservabilityLocalState(input.workspaceDir);
  const consent = resolveEffectiveConsent({
    analyticsPreference: localState.analyticsPreference,
    errorReportingPreference: localState.errorReportingPreference,
    env,
  });

  const handoff = resolveObservabilityHandoff(env);

  const context = buildObservabilityContext({
    sessionId: handoff.sessionId,
    installationId: consent.analyticsEnabled
      ? localState.installationId
      : undefined,
    firstLaunchForPDevHome: isFirstLaunchForPDevHome(localState),
    workspaceKind: input.workspaceKind,
    moduleUrl: input.moduleUrl,
    env,
  });

  state.activeFakeRecorder = input.fakeRecorder;
  await configureTransports({
    consent,
    context,
    moduleUrl: input.moduleUrl,
    env,
    fakeRecorder: input.fakeRecorder,
  });

  state.activeSession = {
    workspaceDir: input.workspaceDir,
    sessionId: handoff.sessionId,
    nonce: handoff.nonce,
    context,
    consent,
    localState,
    moduleUrl: input.moduleUrl,
  };

  emitSessionStartedIfNeeded();
  emitDisplayedConfigureStepViewIfNeeded();

  return state.activeSession;
}

export function getActiveObservabilitySession(): ObservabilitySession | null {
  return runtime().activeSession;
}

export function getObservabilityNonce(): string | null {
  const state = runtime();
  return (
    state.activeSession?.nonce ??
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() ??
    null
  );
}

export async function readObservabilityPreferences(
  workspaceDir: string,
): Promise<ObservabilityLocalState> {
  return readObservabilityLocalState(workspaceDir);
}

export async function writeObservabilityPreferences(
  workspaceDir: string,
  input: UpdateObservabilityPreferencesInput,
): Promise<ObservabilitySession | null> {
  const state = runtime();
  const previousConsent = state.activeSession?.consent;
  let localState = await readObservabilityLocalState(workspaceDir);

  if (
    input.analyticsPreference === "enabled" &&
    !localState.installationId
  ) {
    localState = await updateObservabilityPreferences(workspaceDir, {
      installationId: generateInstallationId(),
    });
  }

  localState = await updateObservabilityPreferences(workspaceDir, input);

  if (!state.activeSession || state.activeSession.workspaceDir !== workspaceDir) {
    return state.activeSession;
  }

  const consent = resolveEffectiveConsent({
    analyticsPreference: localState.analyticsPreference,
    errorReportingPreference: localState.errorReportingPreference,
    env: process.env,
  });

  state.activeSession = {
    ...state.activeSession,
    consent,
    localState,
    context: {
      ...state.activeSession.context,
      installationId: consent.analyticsEnabled
        ? localState.installationId
        : undefined,
    },
  };

  const analyticsChanged =
    previousConsent?.analyticsEnabled !== consent.analyticsEnabled;
  const errorChanged =
    previousConsent?.errorReportingEnabled !== consent.errorReportingEnabled;

  try {
    if (analyticsChanged) {
      await configureTransports({
        consent,
        context: state.activeSession.context,
        moduleUrl: state.activeSession.moduleUrl,
        env: process.env,
        fakeRecorder: state.activeFakeRecorder,
        analyticsOnly: true,
      });
      if (consent.analyticsEnabled) {
        emitSessionStartedIfNeeded();
        emitDisplayedConfigureStepViewIfNeeded();
      }
    }
    if (errorChanged) {
      await configureTransports({
        consent,
        context: state.activeSession.context,
        moduleUrl: state.activeSession.moduleUrl,
        env: process.env,
        fakeRecorder: state.activeFakeRecorder,
        errorOnly: true,
      });
    }
  } catch {
    // vendor failures must not fail preference persistence
  }

  return state.activeSession;
}

export async function resetObservabilityState(
  workspaceDir: string,
): Promise<void> {
  const state = runtime();
  await Promise.all([
    state.analyticsLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
    state.errorLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
  ]);

  await resetObservabilityLocalState(workspaceDir);
  if (state.activeSession?.workspaceDir === workspaceDir) {
    state.activeSession = {
      ...state.activeSession,
      localState: await readObservabilityLocalState(workspaceDir),
      consent: resolveEffectiveConsent({
        analyticsPreference: null,
        errorReportingPreference: null,
      }),
      context: {
        ...state.activeSession.context,
        installationId: undefined,
      },
    };
  }
}

export async function releaseParentObservabilityOwnership(): Promise<void> {
  const state = runtime();
  if (state.parentOwnershipReleased) {
    return;
  }
  state.parentOwnershipReleased = true;
  removeObservabilityFatalHandlers();
  await Promise.all([
    state.analyticsLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
    state.errorLifecycle.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS),
  ]);
}

export function captureAnalyticsEvent(event: AnalyticsEvent): void {
  const state = runtime();
  if (!isAnalyticsCaptureEnabled() || !state.activeSession) {
    return;
  }

  const operationId =
    event.type === "p_dev_workspace_provision_started" ||
    event.type === "p_dev_workspace_provision_completed" ||
    event.type === "p_dev_workspace_provision_failed"
      ? state.activeProvisioningOperationId ?? undefined
      : undefined;

  if (shouldDedupeAnalyticsEvent(state.activeSession.sessionId, event, operationId)) {
    return;
  }

  const eventProperties = analyticsEventToProperties(event);
  const allowedKeys = allowedAnalyticsPropertyKeysForEvent(event);
  assertAllowedPropertyKeys(eventProperties, allowedKeys);

  const properties = {
    ...contextToCommonAnalyticsProperties(state.activeSession.context),
    ...eventProperties,
  };
  assertAllowedPropertyKeys(properties, allowedKeys);

  const payload: SerializedAnalyticsEvent = {
    event: event.type,
    properties,
  };
  try {
    state.analyticsLifecycle.getAdapter().capture(payload);
    recordAnalyticsEventEmission(
      state.activeSession.sessionId,
      event,
      operationId,
    );
  } catch {
    // best-effort
  }
}

export function captureProductError(input: ProductErrorCaptureInput): void {
  if (!isErrorReportingCaptureEnabled()) {
    return;
  }

  const state = runtime();
  const context = contextToSentryTags(
    state.activeSession!.context,
    input.lifecyclePhase,
  );
  try {
    state.errorLifecycle.getAdapter().captureError(input, context);
  } catch {
    // best-effort
  }
}

export function addObservabilityBreadcrumb(breadcrumb: TypedBreadcrumb): void {
  if (!isErrorReportingCaptureEnabled()) {
    return;
  }
  try {
    runtime().errorLifecycle.getAdapter().addBreadcrumb(breadcrumb);
  } catch {
    // best-effort
  }
}

export async function flushObservability(
  deadlineMs = OBSERVABILITY_FLUSH_DEADLINE_MS,
): Promise<void> {
  const state = runtime();
  await Promise.allSettled([
    state.analyticsLifecycle.getAdapter().flush(deadlineMs),
    state.errorLifecycle.getAdapter().flush(deadlineMs),
  ]);
}

export async function shutdownObservability(
  deadlineMs = OBSERVABILITY_FLUSH_DEADLINE_MS,
): Promise<void> {
  const state = runtime();
  removeObservabilityFatalHandlers();
  await Promise.all([
    state.analyticsLifecycle.shutdown(deadlineMs, { flush: true }),
    state.errorLifecycle.shutdown(deadlineMs, { flush: true }),
  ]);
  resetFacadeRuntimeState();
}

export function createObservabilityTestRecorder(): FakeTransportRecorder {
  return createFakeTransportRecorder();
}

export function installObservabilityUncaughtHandlers(): () => void {
  return installObservabilityFatalHandlers(captureProductError);
}
