import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getAgentTelemetryPath } from "../../artifacts/paths.js";
import { boundEventJson } from "./bounds.js";
import { redactTelemetryValue } from "./redact.js";
import { validateTelemetryEvent } from "./validate.js";
import type { AgentTelemetryEvent } from "./types.js";
import { warnOnce } from "../warn.js";

/**
 * Append a validated, redacted, bounded telemetry event to the run-local JSONL.
 * Failures are non-authoritative.
 */
export async function appendTelemetryEvent(
  runDirectory: string,
  event: AgentTelemetryEvent,
): Promise<boolean> {
  try {
    const validated = validateTelemetryEvent(event);
    if (!validated.ok) {
      warnOnce(
        `telemetry-validate:${validated.reason}`,
        `Skipping invalid telemetry event: ${validated.reason}`,
      );
      return false;
    }
    const redacted = redactTelemetryValue(validated.event);
    const { json } = boundEventJson(redacted);
    const filePath = getAgentTelemetryPath(runDirectory);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${json}\n`, "utf8");
    return true;
  } catch (error) {
    warnOnce(
      "telemetry-append",
      `Failed to append telemetry event: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
