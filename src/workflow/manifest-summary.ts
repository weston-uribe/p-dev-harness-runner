import { readFileSync } from "node:fs";
import { redactSecrets } from "../artifacts/redact.js";
import { isPublicRunnerMode } from "../public-execution/mode.js";

export interface ManifestSubset {
  issueKey?: string;
  phase?: string;
  finalOutcome?: string;
  errorClassification?: string | null;
}

function subsetFromRedacted(redacted: Record<string, unknown>): ManifestSubset {
  const publicMode = isPublicRunnerMode();
  return {
    issueKey:
      publicMode
        ? undefined
        : typeof redacted.issueKey === "string"
          ? redacted.issueKey
          : undefined,
    phase: typeof redacted.phase === "string" ? redacted.phase : undefined,
    finalOutcome:
      typeof redacted.finalOutcome === "string" ? redacted.finalOutcome : undefined,
    errorClassification:
      typeof redacted.errorClassification === "string" ||
      redacted.errorClassification === null
        ? (redacted.errorClassification as string | null)
        : undefined,
  };
}

export function readManifestSubsetFromString(raw: string): ManifestSubset | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const redacted = redactSecrets(parsed) as Record<string, unknown>;
    return subsetFromRedacted(redacted);
  } catch {
    return null;
  }
}

export function readManifestSubsetFromFile(path: string): ManifestSubset | null {
  try {
    const raw = readFileSync(path, "utf8");
    return readManifestSubsetFromString(raw);
  } catch {
    return null;
  }
}

export function formatManifestSummaryLines(subset: ManifestSubset): string[] {
  const lines: string[] = [];
  if (subset.issueKey) {
    lines.push(`- Issue key: \`${subset.issueKey}\``);
  }
  if (subset.phase) {
    lines.push(`- Phase: \`${subset.phase}\``);
  }
  if (subset.finalOutcome) {
    lines.push(`- Outcome: \`${subset.finalOutcome}\``);
  }
  lines.push(`- Error classification: \`${subset.errorClassification ?? "none"}\``);
  return lines;
}
