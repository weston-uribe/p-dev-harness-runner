import type { HarnessSecretWritePlanEntry } from "./remote-actions.js";
import type { SetupPermissionScope } from "./permission-model.js";

export type CredentialInputSource = "absent" | "payload" | "enriched-local";

export interface HarnessCredentialFingerprintContext {
  linearApiKey: CredentialInputSource;
  cursorApiKey: CredentialInputSource;
  harnessGithubToken: CredentialInputSource;
  explicitCredentialReplacements: string[];
  envLocalCredentialBaseline: string;
}

export interface HarnessSecretFingerprintInput {
  actionId: string;
  permissionScope: SetupPermissionScope;
  harnessDispatchRepo: string;
  harnessDispatchRepoSource: string;
  secretWritePlan: HarnessSecretWritePlanEntry[];
  credentialInputContext: HarnessCredentialFingerprintContext;
  configLocalHash?: string;
}

export function computeHarnessSecretFingerprint(
  input: HarnessSecretFingerprintInput,
): string {
  const normalized = {
    actionId: input.actionId,
    permissionScope: input.permissionScope,
    harnessDispatchRepo: input.harnessDispatchRepo,
    harnessDispatchRepoSource: input.harnessDispatchRepoSource,
    secretWritePlan: input.secretWritePlan.map((entry) => ({
      name: entry.name,
      action: entry.action,
      source: entry.source,
    })),
    credentialInputContext: {
      linearApiKey: input.credentialInputContext.linearApiKey,
      cursorApiKey: input.credentialInputContext.cursorApiKey,
      harnessGithubToken: input.credentialInputContext.harnessGithubToken,
      explicitCredentialReplacements: [
        ...input.credentialInputContext.explicitCredentialReplacements,
      ].sort(),
      envLocalCredentialBaseline:
        input.credentialInputContext.envLocalCredentialBaseline,
    },
    configLocalHash: input.configLocalHash ?? "",
  };

  return JSON.stringify(normalized);
}
