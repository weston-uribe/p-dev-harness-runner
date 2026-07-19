import { isDispatchPhase } from "../runner/phase-args.js";

const ISSUE_KEY_PATTERN = /^[A-Z]+-[0-9]+$/;
export const REPO_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const VALID_FORCE = new Set(["true", "false"]);

export function validateIssueKey(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  return ISSUE_KEY_PATTERN.test(value.trim().toUpperCase());
}

export function validatePhase(value: string | null | undefined): boolean {
  return isDispatchPhase(value);
}

export function validateForce(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  return VALID_FORCE.has(value.trim().toLowerCase());
}

export function validateRepoIdFormat(
  value: string | null | undefined,
): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  return REPO_ID_PATTERN.test(value.trim());
}

export function validateRepoId(
  value: string | null | undefined,
  allowedIds: readonly string[],
): boolean {
  if (!validateRepoIdFormat(value)) {
    return false;
  }
  return allowedIds.includes(value!.trim());
}
