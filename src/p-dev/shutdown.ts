import type { ChildProcess } from "node:child_process";

export interface ShutdownController {
  register(child: ChildProcess): void;
  cleanup(): Promise<void>;
}

export function createShutdownController(): ShutdownController {
  let child: ChildProcess | undefined;
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (child?.pid !== undefined) {
      try {
        child.kill(signal);
      } catch {
        // Child may already be gone.
      }
    }
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return {
    register(nextChild: ChildProcess): void {
      child = nextChild;
    },
    async cleanup(): Promise<void> {
      if (child?.pid === undefined) {
        return;
      }

      await new Promise<void>((resolve) => {
        if (child?.killed || child?.exitCode !== null) {
          resolve();
          return;
        }

        child?.once("exit", () => {
          resolve();
        });

        try {
          child?.kill("SIGTERM");
        } catch {
          resolve();
        }

        setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 2_000).unref();
      });
    },
  };
}
