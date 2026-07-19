/**
 * Build a minimal Langfuse prompt-link payload without embedding template bodies.
 * Full TextPromptClient.toJSON() may include prompt content — do not store that
 * in local telemetry or PostHog/Sentry.
 */

export function minimalLangfusePromptLinkJson(
  langfusePromptJson: string | null,
  fallback?: {
    name: string;
    version: number | null;
    label: string | null;
  },
): string | null {
  if (langfusePromptJson) {
    try {
      const parsed = JSON.parse(langfusePromptJson) as Record<string, unknown>;
      const link = {
        name: typeof parsed.name === "string" ? parsed.name : fallback?.name,
        version:
          typeof parsed.version === "number"
            ? parsed.version
            : fallback?.version,
        labels: Array.isArray(parsed.labels)
          ? parsed.labels.filter((l): l is string => typeof l === "string")
          : fallback?.label
            ? [fallback.label]
            : [],
      };
      if (link.name && link.version != null) {
        return JSON.stringify(link);
      }
    } catch {
      // fall through
    }
  }
  if (fallback?.name && fallback.version != null) {
    return JSON.stringify({
      name: fallback.name,
      version: fallback.version,
      labels: fallback.label ? [fallback.label] : [],
    });
  }
  return null;
}
