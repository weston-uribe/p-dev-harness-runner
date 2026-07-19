export const P_DEV_RUNTIME_MODE_ENV = "P_DEV_RUNTIME_MODE";

export type PDevRuntimeMode = "packaged" | "source";

export function resolvePDevRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
): PDevRuntimeMode | null {
  const raw = env[P_DEV_RUNTIME_MODE_ENV]?.trim().toLowerCase();
  if (raw === "packaged") {
    return "packaged";
  }
  if (raw === "source" || raw === "development") {
    return "source";
  }
  return null;
}

export function isPackagedPDevRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePDevRuntimeMode(env) === "packaged";
}

export function isSourcePDevRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePDevRuntimeMode(env) === "source";
}
