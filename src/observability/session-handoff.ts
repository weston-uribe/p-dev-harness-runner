import {
  P_DEV_OBSERVABILITY_NONCE_ENV,
  P_DEV_OBSERVABILITY_SESSION_ID_ENV,
} from "./constants.js";
import {
  generateObservabilityNonce,
  generateSessionId,
} from "./identity.js";

export interface ObservabilityHandoff {
  sessionId: string;
  nonce: string;
}

export function createObservabilityHandoff(): ObservabilityHandoff {
  return {
    sessionId: generateSessionId(),
    nonce: generateObservabilityNonce(),
  };
}

export function resolveObservabilityHandoff(
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityHandoff {
  return {
    sessionId:
      env[P_DEV_OBSERVABILITY_SESSION_ID_ENV]?.trim() || generateSessionId(),
    nonce:
      env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() || generateObservabilityNonce(),
  };
}

export function observabilityHandoffEnv(
  handoff: ObservabilityHandoff,
): Record<string, string> {
  return {
    [P_DEV_OBSERVABILITY_SESSION_ID_ENV]: handoff.sessionId,
    [P_DEV_OBSERVABILITY_NONCE_ENV]: handoff.nonce,
  };
}

/** Process-scoped nonce for source GUI launches without beginning a session. */
export function resolveSourceGuiObservabilityNonce(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() || generateObservabilityNonce();
}
