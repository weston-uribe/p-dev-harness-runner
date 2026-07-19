import { readFileSync } from "node:fs";
import { redactSecrets, redactSecretsString } from "../../artifacts/redact.js";

export async function runRedactOutputCommand(): Promise<number> {
  const input = readFileSync(0, "utf8");
  const trimmed = input.trim();
  if (trimmed === "") {
    return 0;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    console.log(JSON.stringify(redactSecrets(parsed), null, 2));
  } catch {
    console.log(redactSecretsString(trimmed));
  }

  return 0;
}
