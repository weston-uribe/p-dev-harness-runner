export interface VercelProjectNameValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

export function validateVercelProjectName(
  projectName: string | undefined,
): VercelProjectNameValidationResult {
  const normalized = projectName?.trim() ?? "";

  if (normalized.length < 1 || normalized.length > 100) {
    return {
      valid: false,
      normalized,
      error: "Vercel project name must be 1-100 characters.",
    };
  }

  if (normalized !== normalized.toLowerCase()) {
    return {
      valid: false,
      normalized,
      error: "Vercel project name must be lowercase.",
    };
  }

  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error:
        "Vercel project name may only contain lowercase letters, numbers, dots, underscores, and hyphens.",
    };
  }

  return { valid: true, normalized };
}
