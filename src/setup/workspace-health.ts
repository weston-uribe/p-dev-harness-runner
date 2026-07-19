/**
 * Three separate health models for workspace entry, Connections, and bridge recovery.
 * Do not collapse these into a single status.
 */

/** Durable workspace maturity — used for entry routing and Settings accessibility. */
export type WorkspaceMaturity = "new" | "established";

/**
 * Vercel (and other) saved-credential health.
 * Live verification belongs in Connections after page load — not on GET /.
 *
 * Preferred operator-facing statuses:
 * connected | credential_invalid | permission_missing | provider_unavailable |
 * bridge_unreachable | local_runtime_error | verification_pending | missing
 *
 * Legacy aliases kept for compatibility: unauthorized≈credential_invalid,
 * checking≈verification_pending, unknown=unable to classify.
 */
export type CredentialHealthStatus =
  | "missing"
  | "checking"
  | "verification_pending"
  | "connected"
  | "unauthorized"
  | "credential_invalid"
  | "permission_missing"
  | "provider_unavailable"
  | "bridge_unreachable"
  | "local_runtime_error"
  | "unknown";

/** PDev automation bridge health derived from durable control-plane evidence or recovery. */
export type PDevBridgeHealthStatus =
  | "missing"
  | "deploying"
  | "unhealthy"
  | "verified";

export function credentialHealthLabel(status: CredentialHealthStatus): string {
  switch (status) {
    case "missing":
      return "Missing";
    case "checking":
    case "verification_pending":
      return "Checking";
    case "connected":
      return "Connected";
    case "unauthorized":
    case "credential_invalid":
      return "Unauthorized";
    case "permission_missing":
      return "Permission missing";
    case "provider_unavailable":
      return "Provider unavailable";
    case "bridge_unreachable":
      return "Bridge unreachable";
    case "local_runtime_error":
      return "Local runtime error";
    case "unknown":
      return "Unable to verify";
  }
}

export function isCredentialFailureStatus(
  status: CredentialHealthStatus,
): boolean {
  return (
    status === "unauthorized" ||
    status === "credential_invalid" ||
    status === "permission_missing"
  );
}

export function isTransientProviderStatus(
  status: CredentialHealthStatus,
): boolean {
  return (
    status === "provider_unavailable" ||
    status === "bridge_unreachable" ||
    status === "unknown"
  );
}

export function bridgeHealthLabel(status: PDevBridgeHealthStatus): string {
  switch (status) {
    case "missing":
      return "Missing";
    case "deploying":
      return "Deploying";
    case "unhealthy":
      return "Unhealthy";
    case "verified":
      return "Verified";
  }
}
