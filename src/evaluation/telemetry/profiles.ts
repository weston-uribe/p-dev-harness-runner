import {
  EVALUATION_CAPTURE_PROFILE_CONTENT,
  EVALUATION_CAPTURE_PROFILE_METADATA,
  type EvaluationCaptureProfile,
} from "../types.js";

/** Capture profiles control Langfuse projection only — not local retention. */
export function isKnownCaptureProfile(
  value: string,
): value is EvaluationCaptureProfile {
  return (
    value === EVALUATION_CAPTURE_PROFILE_METADATA ||
    value === EVALUATION_CAPTURE_PROFILE_CONTENT
  );
}

export function allowsLangfuseContentProjection(
  profile: EvaluationCaptureProfile,
): boolean {
  return profile === EVALUATION_CAPTURE_PROFILE_CONTENT;
}

export function projectForLangfuse<T extends { content?: unknown }>(
  profile: EvaluationCaptureProfile,
  metadata: Record<string, unknown>,
  content: T["content"] | undefined,
): { metadata: Record<string, unknown>; content?: T["content"] } {
  if (allowsLangfuseContentProjection(profile) && content !== undefined) {
    return { metadata, content };
  }
  return { metadata };
}
