import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunEvent } from "../types/run.js";
import { getEventsPath } from "./paths.js";
import { redactSecrets } from "./redact.js";

export class EventLogger {
  private readonly eventsPath: string;

  constructor(runDirectory: string) {
    this.eventsPath = getEventsPath(runDirectory);
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
  }

  async log(
    event: RunEvent["event"],
    level: RunEvent["level"] = "info",
    data?: Record<string, unknown>,
  ): Promise<void> {
    const entry: RunEvent = {
      ts: new Date().toISOString(),
      level,
      event,
      data: data ? (redactSecrets(data) as Record<string, unknown>) : undefined,
    };
    await appendFile(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
