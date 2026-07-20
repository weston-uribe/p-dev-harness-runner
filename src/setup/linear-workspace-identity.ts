const NON_AUTHORITATIVE_WORKSPACE_NAMES = new Set([
  "linear workspace",
  "workspace name unavailable",
]);

export function isNonAuthoritativeLinearWorkspaceName(
  name: string | null | undefined,
): boolean {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) {
    return true;
  }
  return NON_AUTHORITATIVE_WORKSPACE_NAMES.has(trimmed.toLowerCase());
}

export type ResolveAuthoritativeLinearWorkspaceIdentityInput = {
  liveOrganization?: { id: string; name: string } | null;
  liveLookupFailed?: boolean;
  durableWorkspaceId?: string;
  durableWorkspaceName?: string;
  configWorkspaceId?: string;
};

export type AuthoritativeLinearWorkspaceIdentity = {
  workspaceId: string;
  workspaceName: string;
  source: "live" | "durable" | "unavailable";
};

/**
 * Prefer a live Linear organization identity whenever lookup succeeds with a
 * non-empty name. Fall back to durable evidence only when live lookup fails.
 */
export function resolveAuthoritativeLinearWorkspaceIdentity(
  input: ResolveAuthoritativeLinearWorkspaceIdentityInput,
): AuthoritativeLinearWorkspaceIdentity {
  const durableId =
    input.configWorkspaceId?.trim() ||
    input.durableWorkspaceId?.trim() ||
    "";
  const durableName = input.durableWorkspaceName?.trim() ?? "";
  const durableAuthoritative =
    !isNonAuthoritativeLinearWorkspaceName(durableName) && Boolean(durableName);

  if (!input.liveLookupFailed && input.liveOrganization) {
    const liveName = input.liveOrganization.name.trim();
    const liveId = input.liveOrganization.id.trim();
    if (liveName) {
      return {
        workspaceId: liveId || durableId,
        workspaceName: liveName,
        source: "live",
      };
    }
    return {
      workspaceId: liveId || durableId,
      workspaceName: "Workspace name unavailable",
      source: "unavailable",
    };
  }

  if (input.liveLookupFailed && durableAuthoritative) {
    return {
      workspaceId: durableId,
      workspaceName: durableName,
      source: "durable",
    };
  }

  return {
    workspaceId: durableId,
    workspaceName: "Workspace name unavailable",
    source: "unavailable",
  };
}

export function pickDisplayedLinearWorkspaceName(input: {
  bootstrapName?: string;
  healthName?: string;
}): string {
  const bootstrap = input.bootstrapName?.trim() ?? "";
  if (!isNonAuthoritativeLinearWorkspaceName(bootstrap)) {
    return bootstrap;
  }
  const health = input.healthName?.trim() ?? "";
  if (!isNonAuthoritativeLinearWorkspaceName(health)) {
    return health;
  }
  return bootstrap || "Workspace name unavailable";
}
