import {
  collectRemoteSecretInputs,
  redactKnownSecretValues,
  sanitizeSetupActionResult,
} from "./redact-secrets.js";
import type {
  GitHubRemoteSetupProvider,
  HarnessSecretWriteRequest,
} from "./github-remote-provider.js";
import {
  sanitizeGitHubSetupError,
  sanitizeGitHubWorkflowSetupError,
} from "./github-remote-setup-live.js";
import {
  formatHarnessDispatchRepo,
  resolveHarnessDispatchRepo,
} from "./harness-dispatch-repo.js";
import {
  generateHarnessConfigJsonB64,
  previewHarnessSecretSetup,
  readValidatedConfigLocalBytes,
  type HarnessSecretOperatorInput,
} from "./harness-secret-setup.js";
import { recordWorkflowModelsSyncEvidence } from "./workflow-models-sync-evidence.js";
import {
  REMOTE_SETUP_ACTIONS,
  assertRemoteSetupConfirmed,
  assertRemoteSetupFingerprint,
  assertRemoteSetupPermissionScope,
  type HarnessActionsSecretName,
  type HarnessSecretWritePlanEntry,
  type RemoteAccessStatus,
  type RemoteHarnessSecretApplyResult,
  type RemoteHarnessSecretPreview,
  type RemoteTargetWorkflowApplyResult,
  type RemoteTargetWorkflowPreview,
} from "./remote-actions.js";
import { previewTargetWorkflowSetup } from "./target-workflow-setup.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";

export interface RemoteHarnessSecretPreviewOptions {
  cwd?: string;
  operatorInput?: HarnessSecretOperatorInput;
  manualHarnessDispatchRepo?: string;
  provider?: GitHubRemoteSetupProvider;
}

export interface RemoteHarnessSecretApplyOptions
  extends RemoteHarnessSecretPreviewOptions {
  confirmed: boolean;
  fingerprint: string;
}

export interface RemoteTargetWorkflowPreviewOptions {
  cwd?: string;
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  manualHarnessDispatchRepo?: string;
  provider?: GitHubRemoteSetupProvider;
}

export interface RemoteTargetWorkflowApplyOptions
  extends RemoteTargetWorkflowPreviewOptions {
  confirmed: boolean;
  fingerprint: string;
}

function sanitizeRemotePreviewText(
  text: string,
  secrets: readonly string[],
): string {
  return redactKnownSecretValues(text, secrets);
}

async function buildHarnessSecretWriteRequests(input: {
  cwd?: string;
  operatorInput?: HarnessSecretOperatorInput;
  secretWritePlan: HarnessSecretWritePlanEntry[];
}): Promise<{
  requests: HarnessSecretWriteRequest[];
  skippedSecretNames: HarnessActionsSecretName[];
  knownSecrets: string[];
}> {
  const requests: HarnessSecretWriteRequest[] = [];
  const skippedSecretNames: HarnessActionsSecretName[] = [];
  const knownSecrets = collectRemoteSecretInputs(input.operatorInput);

  for (const entry of input.secretWritePlan) {
    if (entry.action === "skip") {
      skippedSecretNames.push(entry.name);
      continue;
    }

    if (entry.name === "HARNESS_CONFIG_JSON_B64") {
      const { bytes } = await readValidatedConfigLocalBytes(input.cwd);
      const encoded = generateHarnessConfigJsonB64(bytes);
      knownSecrets.push(encoded);
      requests.push({ name: entry.name, value: encoded });
      continue;
    }

    const operatorValue =
      entry.name === "LINEAR_API_KEY"
        ? input.operatorInput?.linearApiKey
        : entry.name === "CURSOR_API_KEY"
          ? input.operatorInput?.cursorApiKey
          : entry.name === "VERCEL_TOKEN"
            ? input.operatorInput?.vercelToken
            : input.operatorInput?.githubToken;

    if (!operatorValue?.trim()) {
      skippedSecretNames.push(entry.name);
      continue;
    }

    requests.push({ name: entry.name, value: operatorValue.trim() });
  }

  return { requests, skippedSecretNames, knownSecrets };
}

export async function previewRemoteHarnessSecrets(
  options: RemoteHarnessSecretPreviewOptions,
): Promise<RemoteHarnessSecretPreview> {
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({
    cwd: options.cwd,
    manualRepo: options.manualHarnessDispatchRepo,
  });
  const harnessDispatchRepoSlug = formatHarnessDispatchRepo(harnessDispatchRepo);

  let repoAccess: RemoteAccessStatus = "unknown";
  let secretStatuses = undefined;

  if (options.provider && harnessDispatchRepo.resolved) {
    repoAccess = await options.provider.checkHarnessRepoAccess(
      harnessDispatchRepoSlug,
    );
    secretStatuses = await options.provider.listHarnessSecretStatuses(
      harnessDispatchRepoSlug,
    );
  }

  const preview = await previewHarnessSecretSetup({
    cwd: options.cwd,
    operatorInput: options.operatorInput,
    manualHarnessDispatchRepo: options.manualHarnessDispatchRepo,
    secretStatuses,
    repoAccess,
  });

  const knownSecrets = collectRemoteSecretInputs(options.operatorInput);
  const manualInstructions = preview.manualInstructions.map((step) =>
    sanitizeRemotePreviewText(step, knownSecrets),
  );

  return {
    actionId: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.id,
    harnessDispatchRepo: harnessDispatchRepoSlug,
    harnessDispatchRepoResolved: harnessDispatchRepo.resolved,
    harnessDispatchRepoSource: harnessDispatchRepo.source,
    repoAccess,
    secretStatuses:
      secretStatuses ??
      preview.secretWritePlan.map((entry) => ({
        name: entry.name,
        status: "unknown" as const,
      })),
    secretWritePlan: preview.secretWritePlan,
    secretKeyNames: preview.secretWritePlan
      .filter((entry) => entry.action !== "skip")
      .map((entry) => entry.name),
    fingerprint: preview.fingerprint,
    permission: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.permission,
    manualInstructions,
    validationError: preview.validationError
      ? sanitizeRemotePreviewText(preview.validationError, knownSecrets)
      : undefined,
  };
}

export async function applyRemoteHarnessSecrets(
  options: RemoteHarnessSecretApplyOptions,
): Promise<RemoteHarnessSecretApplyResult> {
  assertRemoteSetupConfirmed(options.confirmed);
  assertRemoteSetupPermissionScope(
    REMOTE_SETUP_ACTIONS.applyHarnessSecrets.permission.scope,
    SETUP_PERMISSIONS.remoteSecretWrite.scope,
  );

  const preview = await previewRemoteHarnessSecrets(options);
  assertRemoteSetupFingerprint(options.fingerprint, preview.fingerprint);

  if (preview.validationError) {
    throw new Error(preview.validationError);
  }

  if (!options.provider) {
    throw new Error("GitHub token is required for remote harness secret writes");
  }

  if (!preview.harnessDispatchRepoResolved) {
    throw new Error("Harness dispatch repo must be resolved before applying secrets");
  }

  const { requests, skippedSecretNames, knownSecrets } =
    await buildHarnessSecretWriteRequests({
      cwd: options.cwd,
      operatorInput: options.operatorInput,
      secretWritePlan: preview.secretWritePlan,
    });

  if (requests.length === 0) {
    throw new Error("No harness repo Actions secrets are ready to write");
  }

  try {
    const writtenSecrets = await options.provider.writeHarnessSecrets(
      preview.harnessDispatchRepo,
      requests,
    );

    const result: RemoteHarnessSecretApplyResult = {
      actionId: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.id,
      harnessDispatchRepo: preview.harnessDispatchRepo,
      writtenSecrets,
      skippedSecretNames,
      fingerprint: preview.fingerprint,
      permission: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.permission,
    };

    const serialized = JSON.stringify(result);
    for (const secret of knownSecrets) {
      if (serialized.includes(secret)) {
        throw new Error("Remote apply result leaked secret material");
      }
    }

    const wroteHarnessConfigB64 = writtenSecrets.some(
      (entry) =>
        entry.name === "HARNESS_CONFIG_JSON_B64" &&
        (entry.status === "created" || entry.status === "updated"),
    );
    if (wroteHarnessConfigB64) {
      const { hash } = await readValidatedConfigLocalBytes(options.cwd);
      const {
        HARNESS_CONFIG_FINGERPRINT_VARIABLE,
      } = await import("../config/cloud-config-fingerprint.js");
      if (!options.provider.writeHarnessVariables) {
        throw new Error(
          "GitHub provider must support repository variable writes for HARNESS_CONFIG_FINGERPRINT",
        );
      }
      await options.provider.writeHarnessVariables(preview.harnessDispatchRepo, [
        { name: HARNESS_CONFIG_FINGERPRINT_VARIABLE, value: hash },
      ]);
      try {
        await recordWorkflowModelsSyncEvidence(
          {
            configFingerprint: hash,
            harnessRepository: preview.harnessDispatchRepo,
            syncedAt: new Date().toISOString(),
          },
          options.cwd,
        );
      } catch {
        // Sync evidence is bookkeeping; do not fail the secret apply transaction.
      }
    }

    return result;
  } catch (error) {
    throw new Error(sanitizeGitHubSetupError(error));
  }
}

export async function previewRemoteTargetWorkflow(
  options: RemoteTargetWorkflowPreviewOptions,
): Promise<RemoteTargetWorkflowPreview> {
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({
    cwd: options.cwd,
    manualRepo: options.manualHarnessDispatchRepo,
  });

  const initialPreview = previewTargetWorkflowSetup({
    repoConfigId: options.repoConfigId,
    targetRepo: options.targetRepo,
    productionBranch: options.productionBranch,
    harnessDispatchRepo,
  });

  let workflowStatus = initialPreview.plan.workflowStatus;
  let repoAccess: RemoteAccessStatus = "unknown";
  let productionBranchSha: string | undefined;

  if (
    options.provider &&
    initialPreview.plan.targetRepoSlug !== "<invalid-target-repo>"
  ) {
    const status = await options.provider.checkTargetWorkflowStatus({
      targetRepoSlug: initialPreview.plan.targetRepoSlug,
      workflowPath: initialPreview.plan.workflowPath,
      intendedWorkflowContent: initialPreview.workflowContent,
      productionBranch: options.productionBranch,
    });
    workflowStatus = status.workflowStatus;
    repoAccess = status.repoAccess;
    productionBranchSha = status.productionBranchSha;
  }

  const preview = previewTargetWorkflowSetup({
    repoConfigId: options.repoConfigId,
    targetRepo: options.targetRepo,
    productionBranch: options.productionBranch,
    harnessDispatchRepo,
    workflowStatus,
    productionBranchSha,
  });

  return {
    actionId: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.id,
    plan: preview.plan,
    repoAccess,
    workflowPreviewSummary: preview.workflowPreviewSummary,
    fingerprint: preview.fingerprint,
    permission: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.permission,
    manualInstructions: preview.manualInstructions,
    validationError: preview.validationError,
  };
}

export async function applyRemoteTargetWorkflow(
  options: RemoteTargetWorkflowApplyOptions,
): Promise<RemoteTargetWorkflowApplyResult> {
  assertRemoteSetupConfirmed(options.confirmed);
  assertRemoteSetupPermissionScope(
    REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.permission.scope,
    SETUP_PERMISSIONS.remoteRepoWrite.scope,
  );

  const preview = await previewRemoteTargetWorkflow(options);
  assertRemoteSetupFingerprint(options.fingerprint, preview.fingerprint);

  if (preview.validationError) {
    throw new Error(preview.validationError);
  }

  if (preview.plan.directProductionBranchWrite !== false) {
    throw new Error("Direct production branch writes are not allowed");
  }

  if (!options.provider) {
    throw new Error("GitHub token is required for target workflow PR install");
  }

  try {
    const applyResult = await options.provider.applyTargetWorkflowPr({
      targetRepoSlug: preview.plan.targetRepoSlug,
      productionBranch: preview.plan.productionBranch,
      branchName: preview.plan.branchName,
      workflowPath: preview.plan.workflowPath,
      workflowContent: (
        await previewTargetWorkflowSetup({
          repoConfigId: options.repoConfigId,
          targetRepo: options.targetRepo,
          productionBranch: options.productionBranch,
          harnessDispatchRepo: await resolveHarnessDispatchRepo({
            cwd: options.cwd,
            manualRepo: options.manualHarnessDispatchRepo,
          }),
          workflowStatus: preview.plan.workflowStatus,
        })
      ).workflowContent,
      prTitle: preview.plan.prTitle,
      prBody: preview.plan.prBody,
    });

    return {
      actionId: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.id,
      harnessDispatchRepo: preview.plan.harnessDispatchRepo,
      repoConfigId: preview.plan.repoConfigId,
      outcome: applyResult.outcome,
      branchName: applyResult.branchName,
      prUrl: applyResult.prUrl,
      directProductionBranchWrite: false,
      fingerprint: preview.fingerprint,
      permission: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.permission,
    };
  } catch (error) {
    throw new Error(sanitizeGitHubWorkflowSetupError(error));
  }
}

export function sanitizeRemoteHarnessSecretPreview(
  preview: RemoteHarnessSecretPreview,
  knownSecrets: readonly string[] = [],
): RemoteHarnessSecretPreview {
  return {
    ...preview,
    manualInstructions: preview.manualInstructions.map((step) =>
      sanitizeRemotePreviewText(step, knownSecrets),
    ),
    validationError: preview.validationError
      ? sanitizeRemotePreviewText(preview.validationError, knownSecrets)
      : undefined,
  };
}

export function toSanitizedRemoteSetupActionResult(
  preview: RemoteHarnessSecretPreview,
  knownSecrets: readonly string[] = [],
) {
  return sanitizeSetupActionResult(
    {
      actionId: preview.actionId,
      outcome: "preview",
      permission: preview.permission,
      reason: preview.secretKeyNames.length
        ? `Would write secret keys: ${preview.secretKeyNames.join(", ")}`
        : "No harness repo secrets would be written",
      manualInstructions: preview.manualInstructions,
    },
    knownSecrets,
  );
}
