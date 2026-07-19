import type { GuidedDisplayStepId } from "./analytics-schemas.js";
import type { ObservabilitySession } from "./facade.js";
import {
  createAnalyticsLifecycle,
  createErrorLifecycle,
  type CategoryTransportLifecycle,
} from "./transport-lifecycle.js";
import type {
  AnalyticsTransport,
  ErrorTransport,
  FakeTransportRecorder,
} from "./types.js";

const STATE_KEY = Symbol.for("@harness/observability/facade-runtime");

export interface FacadeRuntimeState {
  activeSession: ObservabilitySession | null;
  analyticsLifecycle: CategoryTransportLifecycle<AnalyticsTransport>;
  errorLifecycle: CategoryTransportLifecycle<ErrorTransport>;
  runtimeEligible: boolean;
  activeFakeRecorder: FakeTransportRecorder | undefined;
  parentOwnershipReleased: boolean;
  displayedConfigureStepId: GuidedDisplayStepId | null;
  activeProvisioningOperationId: string | null;
}

export function getFacadeRuntimeState(): FacadeRuntimeState {
  const globalState = globalThis as Record<symbol, FacadeRuntimeState | undefined>;
  if (!globalState[STATE_KEY]) {
    globalState[STATE_KEY] = {
      activeSession: null,
      analyticsLifecycle: createAnalyticsLifecycle(),
      errorLifecycle: createErrorLifecycle(),
      runtimeEligible: false,
      activeFakeRecorder: undefined,
      parentOwnershipReleased: false,
      displayedConfigureStepId: null,
      activeProvisioningOperationId: null,
    };
  }
  return globalState[STATE_KEY];
}

export function resetFacadeRuntimeState(): void {
  const globalState = globalThis as Record<symbol, FacadeRuntimeState | undefined>;
  delete globalState[STATE_KEY];
}
