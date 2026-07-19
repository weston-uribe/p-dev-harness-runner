export const P_DEV_PUBLIC_RUNNER_MODE_ENV = "P_DEV_PUBLIC_RUNNER_MODE";

export function isPublicRunnerMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[P_DEV_PUBLIC_RUNNER_MODE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
