import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";

export interface RuntimeEligibilityOptions {
  env?: NodeJS.ProcessEnv;
  allowFakeTransport?: boolean;
}

export function isObservabilityRuntimeEligible(
  options: RuntimeEligibilityOptions = {},
): boolean {
  const env = options.env ?? process.env;

  if (options.allowFakeTransport) {
    return true;
  }

  if (!isPackagedPDevRuntime(env)) {
    return false;
  }

  if (env.VITEST === "true" || env.VITEST === "1") {
    return false;
  }

  if (env.NODE_ENV === "test") {
    return false;
  }

  if (env.CI === "true" || env.CI === "1") {
    return false;
  }

  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_ACTIONS === "1") {
    return false;
  }

  if (env.VERCEL === "1" || env.VERCEL === "true") {
    return false;
  }

  if (env.P_DEV_OBSERVABILITY_PREP === "1") {
    return false;
  }

  if (env.P_DEV_SNAPSHOT_GENERATION === "1") {
    return false;
  }

  return true;
}
