import type { ProductErrorCaptureInput } from "./types.js";

let installed = false;
let capturingFatal = false;
let removeListener: (() => void) | null = null;
const seenFatalKeys = new Set<string>();

function fatalKey(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }
  return String(error);
}

export function installObservabilityFatalHandlers(
  capture: (input: ProductErrorCaptureInput) => void,
): () => void {
  if (installed && removeListener) {
    return removeListener;
  }

  const onUncaughtExceptionMonitor = (error: Error) => {
    if (capturingFatal) {
      return;
    }
    const key = fatalKey(error);
    if (seenFatalKeys.has(key)) {
      return;
    }
    seenFatalKeys.add(key);
    capturingFatal = true;
    try {
      capture({
        lifecyclePhase: "launcher_startup",
        productErrorCode: "uncaught_exception",
        errorCategory: "unexpected",
        cause: error,
      });
    } catch {
      // fatal telemetry must never recurse or prevent exit
    } finally {
      capturingFatal = false;
    }
  };

  process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  installed = true;
  removeListener = () => {
    process.removeListener("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    installed = false;
    removeListener = null;
    seenFatalKeys.clear();
    capturingFatal = false;
  };
  return removeListener;
}

export function removeObservabilityFatalHandlers(): void {
  removeListener?.();
}
