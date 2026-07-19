import type { LocalReadinessCheckResult } from "@harness/setup/local-readiness-checks";

export type LocalReadinessVisualEvent =
  | { type: "check-started"; id: string; label: string }
  | { type: "check-completed"; check: LocalReadinessCheckResult };

const VISUAL_TRANSITION_MS = 280;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export class LocalReadinessVisualQueue {
  private queue: LocalReadinessVisualEvent[] = [];
  private draining = false;
  private cancelled = false;

  constructor(
    private readonly onDispatch: (event: LocalReadinessVisualEvent) => void,
    private readonly reducedMotion: boolean,
  ) {}

  enqueue(event: LocalReadinessVisualEvent): void {
    this.queue.push(event);
    void this.drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
  }

  reset(): void {
    this.cancelled = false;
    this.queue = [];
    this.draining = false;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.cancelled) {
      return;
    }
    this.draining = true;
    while (this.queue.length > 0 && !this.cancelled) {
      const event = this.queue.shift();
      if (!event) {
        break;
      }
      this.onDispatch(event);
      if (!this.reducedMotion) {
        await sleep(VISUAL_TRANSITION_MS);
      }
    }
    this.draining = false;
    if (this.queue.length > 0 && !this.cancelled) {
      void this.drain();
    }
  }
}
