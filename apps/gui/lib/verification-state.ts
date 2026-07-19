import {
  INITIAL_SERVICE_VERIFICATION,
  type ServiceKey,
  type ServiceVerificationMap,
  type ServiceVerificationUi,
} from "@/components/custom/environment-config-form";
import type { RepoVerificationUi } from "@/components/custom/target-repo-config-form";
import type { ServiceConnectionSummaryMap } from "@/lib/setup-server";
import type { SavedCredentialHealthMap } from "@harness/setup/credential-health";
import type { CredentialHealthStatus } from "@harness/setup/workspace-health";

const SERVICE_KEYS: ServiceKey[] = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
];

export function serviceVerificationFromSummaries(
  summaries: ServiceConnectionSummaryMap,
): ServiceVerificationMap {
  return SERVICE_KEYS.reduce(
    (next, key) => {
      const summary = summaries[key];
      if (summary.status === "connected") {
        next[key] = {
          state: "connected",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else if (summary.status === "unauthorized") {
        next[key] = {
          state: "unauthorized",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else if (summary.status === "unknown") {
        next[key] = {
          state: "unknown",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else if (summary.status === "failed") {
        next[key] = {
          state: "failed",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else if (summary.status === "checking") {
        next[key] = {
          state: "checking",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else if (summary.status === "missing") {
        next[key] = {
          state: "missing",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      } else {
        next[key] = {
          state: "unchecked",
          message: summary.message,
          limitation: summary.limitation,
          label: summary.label,
        };
      }
      return next;
    },
    { ...INITIAL_SERVICE_VERIFICATION },
  );
}

/**
 * Initial Settings summaries: Missing when absent, Checking when present.
 * Never Connected from presence alone — live verify updates after mount.
 */
export function loadDurableServiceConnectionSummaries(
  presence: Record<ServiceKey, boolean>,
): ServiceConnectionSummaryMap {
  return Object.fromEntries(
    SERVICE_KEYS.map((key) => [
      key,
      presence[key]
        ? {
            status: "checking" as const,
            message: "Checking saved credential…",
          }
        : {
            status: "missing" as const,
            message: "Missing.",
          },
    ]),
  ) as ServiceConnectionSummaryMap;
}

export function serviceVerificationFromCredentialHealth(
  health: SavedCredentialHealthMap,
): ServiceVerificationMap {
  return SERVICE_KEYS.reduce(
    (next, key) => {
      const entry = health[key];
      next[key] = {
        state: credentialHealthToUiState(entry.status),
        message: entry.message,
        limitation: entry.limitation,
        label: entry.label,
      };
      return next;
    },
    { ...INITIAL_SERVICE_VERIFICATION },
  );
}

function credentialHealthToUiState(
  status: CredentialHealthStatus,
): ServiceVerificationUi["state"] {
  switch (status) {
    case "missing":
      return "missing";
    case "checking":
    case "verification_pending":
      return "checking";
    case "connected":
      return "connected";
    case "unauthorized":
    case "credential_invalid":
    case "permission_missing":
      return "unauthorized";
    case "local_runtime_error":
      return "failed";
    case "provider_unavailable":
    case "bridge_unreachable":
    case "unknown":
      return "unknown";
  }
}

/** Non-secret in-memory fingerprint for comparing typed secret values. */
export function valueFingerprint(value: string): string {
  const trimmed = value.trim();
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash << 5) - hash + trimmed.charCodeAt(i);
    hash |= 0;
  }
  return `fp:${hash}:${trimmed.length}`;
}

export function isServiceVerifiedForValue(
  verification: ServiceVerificationUi,
  value: string,
): boolean {
  if (verification.state !== "connected") {
    return false;
  }
  if (!value.trim()) {
    return false;
  }
  return verification.verifiedValueFingerprint === valueFingerprint(value);
}

export function isServiceFailedForValue(
  verification: ServiceVerificationUi,
  value: string,
): boolean {
  if (
    verification.state !== "failed" &&
    verification.state !== "unauthorized" &&
    verification.state !== "unknown"
  ) {
    return false;
  }
  if (!value.trim()) {
    return false;
  }
  return verification.attemptedValueFingerprint === valueFingerprint(value);
}

export function resolveServiceConnectionBadgeState(
  present: boolean,
  verification: ServiceVerificationUi,
  value: string,
): ServiceVerificationUi["state"] {
  if (verification.state === "checking") {
    return "checking";
  }

  const trimmedValue = value.trim();

  if (verification.state === "connected") {
    if (trimmedValue) {
      return isServiceVerifiedForValue(verification, trimmedValue)
        ? "connected"
        : "unchecked";
    }
    // Saved credential verified — Connected. Presence alone is not enough;
    // only return connected when verification.state is already connected.
    return "connected";
  }

  if (
    verification.state === "unauthorized" ||
    verification.state === "unknown" ||
    verification.state === "missing" ||
    verification.state === "failed"
  ) {
    if (trimmedValue) {
      return isServiceFailedForValue(verification, trimmedValue)
        ? verification.state
        : "unchecked";
    }
    return verification.state;
  }

  if (!present && !trimmedValue) {
    return "missing";
  }

  return "unchecked";
}

export function isRepoVerifiedForUrl(
  verification: RepoVerificationUi | undefined,
  targetRepo: string,
): boolean {
  if (!verification || verification.state !== "connected") {
    return false;
  }
  const normalized = targetRepo.trim();
  if (!normalized) {
    return false;
  }
  return verification.verifiedTargetRepo === normalized;
}

export type GitHubTokenSource = "typed" | "saved";

/** Non-secret fingerprint for repo checks that used the saved `.env.local` token. */
export const SAVED_GITHUB_TOKEN_FINGERPRINT = "saved-local";

export interface ActiveGitHubToken {
  /** Present when the user pasted a token in Step 1 during this session. */
  tokenForRequest?: string;
  source: GitHubTokenSource;
  fingerprint: string;
}

export function resolveActiveGitHubToken(options: {
  typedToken: string;
  hasSavedToken: boolean;
}): ActiveGitHubToken | null {
  const trimmed = options.typedToken.trim();
  if (trimmed) {
    return {
      tokenForRequest: trimmed,
      source: "typed",
      fingerprint: valueFingerprint(trimmed),
    };
  }

  if (options.hasSavedToken) {
    return {
      source: "saved",
      fingerprint: SAVED_GITHUB_TOKEN_FINGERPRINT,
    };
  }

  return null;
}

export const GITHUB_TOKEN_SOURCE_HINT: Record<GitHubTokenSource, string> = {
  typed: "Using current GitHub token from Step 1.",
  saved: "Using saved GitHub token.",
};

export function isRepoVerifiedForActiveToken(
  verification: RepoVerificationUi | undefined,
  targetRepo: string,
  activeGithubTokenFingerprint: string | null,
): boolean {
  if (!activeGithubTokenFingerprint) {
    return false;
  }
  if (!isRepoVerifiedForUrl(verification, targetRepo)) {
    return false;
  }
  return (
    verification?.verifiedGithubTokenFingerprint === activeGithubTokenFingerprint
  );
}

export function isRepoFailedForActiveToken(
  verification: RepoVerificationUi | undefined,
  targetRepo: string,
  activeGithubTokenFingerprint: string | null,
): boolean {
  if (!activeGithubTokenFingerprint || !verification) {
    return false;
  }
  if (verification.state !== "failed") {
    return false;
  }
  const normalized = targetRepo.trim();
  if (!normalized || verification.attemptedTargetRepo !== normalized) {
    return false;
  }
  return (
    verification.attemptedGithubTokenFingerprint === activeGithubTokenFingerprint
  );
}

export function createGuidedRepoRowId(counter: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `guided-repo-${counter}`;
}

export type GuidedRepoRow = {
  rowId: string;
  id: string;
  targetRepo: string;
  baseBranch?: string;
  productionBranch?: string;
  linearProjects?: string;
  linearTeams?: string;
  previewProvider?: string;
  integrationPreviewUrl?: string;
  productionUrl?: string;
  integrationSuccessStatus?: string;
  productionSuccessStatus?: string;
  validationCommands?: string;
};

export function guidedRowsFromConfig(
  config: { repos: Array<Omit<GuidedRepoRow, "rowId">> },
  startCounter = 1,
): GuidedRepoRow[] {
  const repos =
    config.repos.length > 0 ? config.repos : [{ id: "", targetRepo: "" }];
  return repos.map((repo, index) => ({
    ...repo,
    rowId: createGuidedRepoRowId(startCounter + index),
  }));
}

export function guidedRowsToConfigRepos(
  rows: GuidedRepoRow[],
): Array<Omit<GuidedRepoRow, "rowId">> {
  return rows.map(({ rowId: _rowId, ...repo }) => repo);
}
