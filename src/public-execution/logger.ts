import {
  pickPublicSafeLogFields,
  type PublicSafeLogRecord,
} from "./allowed-fields.js";
import { assertPublicSafe } from "./redaction-validator.js";

export class PublicSafeLogger {
  log(record: PublicSafeLogRecord): void {
    const picked = pickPublicSafeLogFields(record);
    const json = JSON.stringify(picked);
    assertPublicSafe(json);
    console.log(json);
  }
}

export function formatPublicSafeSummary(record: PublicSafeLogRecord): string {
  const picked = pickPublicSafeLogFields(record);
  const lines = ["## Public execution summary", ""];

  for (const [key, value] of Object.entries(picked)) {
    lines.push(`- **${key}**: ${String(value)}`);
  }

  const markdown = lines.join("\n");
  assertPublicSafe(markdown);
  return markdown;
}
