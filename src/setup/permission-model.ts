export type SetupPermissionScope =
  | "read-only"
  | "local-file-write"
  | "remote-read"
  | "remote-secret-write"
  | "remote-repo-write"
  | "cloud-workflow-trigger"
  | "linear-write";

export type SetupConfirmationLevel =
  | "none"
  | "standard"
  | "strong"
  | "high-risk";

export interface SetupPermission {
  scope: SetupPermissionScope;
  confirmation: SetupConfirmationLevel;
  manualAlternative: boolean;
}

export const SETUP_PERMISSIONS = {
  readOnly: {
    scope: "read-only",
    confirmation: "none",
    manualAlternative: false,
  },
  localFileWrite: {
    scope: "local-file-write",
    confirmation: "standard",
    manualAlternative: true,
  },
  remoteRead: {
    scope: "remote-read",
    confirmation: "standard",
    manualAlternative: true,
  },
  remoteSecretWrite: {
    scope: "remote-secret-write",
    confirmation: "strong",
    manualAlternative: true,
  },
  remoteRepoWrite: {
    scope: "remote-repo-write",
    confirmation: "strong",
    manualAlternative: true,
  },
  cloudWorkflowTrigger: {
    scope: "cloud-workflow-trigger",
    confirmation: "strong",
    manualAlternative: true,
  },
  linearWrite: {
    scope: "linear-write",
    confirmation: "high-risk",
    manualAlternative: true,
  },
} as const satisfies Record<string, SetupPermission>;

export function classifySetupPermission(
  scope: SetupPermissionScope,
): SetupPermission {
  switch (scope) {
    case "read-only":
      return SETUP_PERMISSIONS.readOnly;
    case "local-file-write":
      return SETUP_PERMISSIONS.localFileWrite;
    case "remote-read":
      return SETUP_PERMISSIONS.remoteRead;
    case "remote-secret-write":
      return SETUP_PERMISSIONS.remoteSecretWrite;
    case "remote-repo-write":
      return SETUP_PERMISSIONS.remoteRepoWrite;
    case "cloud-workflow-trigger":
      return SETUP_PERMISSIONS.cloudWorkflowTrigger;
    case "linear-write":
      return SETUP_PERMISSIONS.linearWrite;
  }
}
