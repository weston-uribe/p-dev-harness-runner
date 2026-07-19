import type { AnalyticsTransport, ErrorTransport } from "./types.js";
import {
  createNoopAnalyticsTransport,
  createNoopErrorTransport,
} from "./adapters/noop.js";

export type ObservabilityCategory = "analytics" | "error";

export interface TransportShutdownOptions {
  flush?: boolean;
}

type AnyTransport = AnalyticsTransport | ErrorTransport;

interface CategoryState<T extends AnyTransport> {
  gateOpen: boolean;
  adapter: T;
  noop: T;
}

export class CategoryTransportLifecycle<T extends AnyTransport> {
  private state: CategoryState<T>;

  constructor(noop: T) {
    this.state = {
      gateOpen: false,
      adapter: noop,
      noop,
    };
  }

  isCaptureEnabled(): boolean {
    return this.state.gateOpen;
  }

  isAdapterActive(): boolean {
    return this.state.adapter.isActive();
  }

  getAdapter(): T {
    return this.state.adapter;
  }

  async enable(factory: () => T): Promise<void> {
    if (this.state.gateOpen && this.state.adapter.isActive()) {
      return;
    }
    if (this.state.adapter.isActive()) {
      await this.state.adapter.disableAndDrop(0);
    }
    this.state.gateOpen = true;
    try {
      this.state.adapter = factory();
    } catch {
      this.state.gateOpen = false;
      this.state.adapter = this.state.noop;
    }
  }

  async disableAndDrop(deadlineMs: number): Promise<void> {
    this.state.gateOpen = false;
    const outgoing = this.state.adapter;
    this.state.adapter = this.state.noop;
    if (outgoing.isActive()) {
      try {
        await outgoing.disableAndDrop(deadlineMs);
      } catch {
        // best-effort vendor isolation
      }
    }
  }

  async shutdown(deadlineMs: number, options?: TransportShutdownOptions): Promise<void> {
    this.state.gateOpen = false;
    const outgoing = this.state.adapter;
    this.state.adapter = this.state.noop;
    if (outgoing.isActive()) {
      try {
        await outgoing.shutdown({ flush: options?.flush ?? true, deadlineMs });
      } catch {
        // best-effort
      }
    }
  }
}

export function createAnalyticsLifecycle(): CategoryTransportLifecycle<AnalyticsTransport> {
  return new CategoryTransportLifecycle(createNoopAnalyticsTransport());
}

export function createErrorLifecycle(): CategoryTransportLifecycle<ErrorTransport> {
  return new CategoryTransportLifecycle(createNoopErrorTransport());
}
