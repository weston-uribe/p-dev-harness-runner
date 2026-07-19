import { redactSecretsString } from "../artifacts/redact.js";

export const FLUSH_TIMEOUT_MS = 5_000;

const WARNED = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(`[p-dev-evaluation] ${redactSecretsString(message)}`);
}

/** Test helper to reset warn-once state. */
export function resetEvaluationWarningsForTests(): void {
  WARNED.clear();
}

export async function withFlushTimeout(
  work: () => Promise<void>,
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          warnOnce(
            "flush-timeout",
            `Evaluation flush exceeded ${timeoutMs}ms; continuing without waiting`,
          );
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    warnOnce(
      "flush-error",
      `Evaluation flush failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
