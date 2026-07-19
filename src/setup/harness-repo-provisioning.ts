import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolveHarnessPackageVersion } from "../p-dev/package-version.js";
import { isPackagedPDevRuntime } from "../p-dev/runtime-mode.js";
import { GitHubApiError } from "../github/client.js";
import { readExistingEnvFile } from "./env-merge.js";
import {
  resolveStep1TrustedHarnessRepo,
  step1TrustedHarnessRepoMessage,
} from "./harness-step-readiness-server.js";
import {
  buildHarnessProvisioningPreviewContext,
  normalizeRepoSlug,
  serializeHarnessProvisioningPreviewContext,
  validateSubmittedHarnessProvisioningFingerprint,
  type HarnessProvisioningClassification,
} from "./harness-provisioning-context.js";
import {
  buildHarnessManagedRepoMarker,
  HARNESS_MANAGED_REPO_MARKER_FILE,
  markersAreEquivalentForOperation,
  markerValidForExistingWorkspace,
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
} from "./harness-managed-repo-marker.js";
import {
  buildPendingValidationContext,
  clearHarnessProvisioningPendingState,
  readHarnessProvisioningPendingState,
  validatePendingProvisioningState,
  withHarnessProvisioningMutex,
  writeHarnessProvisioningPendingStateAtomic,
  type HarnessProvisioningPendingState,
  type HarnessProvisioningPhase,
} from "./harness-provisioning-pending-state.js";
import {
  clearHarnessProvisioningProgress,
  mapProvisioningPhaseToUiPhase,
  uiPhaseLabel,
  writeHarnessProvisioningProgressAtomic,
} from "./harness-provisioning-progress.js";
import { persistHarnessProvisioningLastRun } from "./harness-provisioning-last-run.js";
import { parseRepoSlug } from "./github-remote-setup-live.js";
import type { GitHubHarnessProvisioningProvider } from "./github-remote-provider.js";
import {
  assessPackagedProvisioningTokenCapabilities,
  type GitHubTokenMetadata,
} from "./github-workflow-permissions.js";
import {
  HARNESS_DEFAULT_DESTINATION_DESCRIPTION,
  HARNESS_DEFAULT_DESTINATION_REPO_NAME,
  HARNESS_LEGACY_PUBLIC_SOURCE_REPO,
  HARNESS_TEMPLATE_IDENTITY_FILE,
  parseHarnessTemplateIdentityJson,
} from "./harness-template-identity.js";
import {
  SnapshotProvisioningError,
} from "./harness-snapshot-provisioning-helpers.js";
import {
  provisionHarnessWorkspaceFromSnapshot,
  type SnapshotProvisioningTimings,
  verifyProvisionedHarnessWorkspace,
} from "./harness-snapshot-provisioning.js";
import { loadEmbeddedWorkspaceSnapshot } from "./harness-workspace-snapshot-loader.js";
import { persistGithubDispatchRepository } from "./local-apply-actions.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export type HarnessProvisioningState =
  | "skipped-not-packaged"
  | "skipped-source-mode"
  | "token-unavailable"
  | "token-invalid"
  | "token-unsupported"
  | "token-scope-ambiguous"
  | "token-insufficient"
  | "explicit-repo-present"
  | "explicit-packaged-repo-invalid"
  | "explicit-packaged-repo-legacy-source"
  | "snapshot-unavailable"
  | "snapshot-manifest-missing"
  | "snapshot-manifest-invalid"
  | "snapshot-incompatible"
  | "snapshot-tampered"
  | "snapshot-preview-ready"
  | "snapshot-preview-stale"
  | "repo-absent"
  | "valid-existing-managed-repo"
  | "same-name-public-collision"
  | "same-name-unmanaged-collision"
  | "same-name-malformed-marker"
  | "same-name-snapshot-only-without-pending"
  | "same-name-snapshot-only-with-pending"
  | "repo-created-pending-verification"
  | "marker-write-pending"
  | "verified-and-persisted"
  | "created-but-persistence-failed"
  | "api-timeout-unknown"
  | "concurrent-request-recovered";

export interface HarnessRepoProvisioningSummary {
  runtimeMode: "packaged" | "source" | "unknown";
  eligible: boolean;
  state: HarnessProvisioningState;
  harnessDispatchRepo: string | null;
  authenticatedLogin: string | null;
  message: string;
  recoverable: boolean;
  connectedAutomatically: boolean;
  verifiedSavedRepo: boolean;
}

export interface HarnessRepoProvisioningPreview {
  state: HarnessProvisioningState;
  fingerprint: string;
  operationId: string;
  creationPreviewFingerprint: string | null;
  resumedFromPending: boolean;
  harnessDispatchRepo: string | null;
  authenticatedLogin: string | null;
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  snapshotContentId: string | null;
  snapshotFingerprint: string | null;
  /** @deprecated Use snapshotContentId. */
  templateContentId: string | null;
  message: string;
  recoverable: boolean;
  willCreateRepository: boolean;
  tokenCapabilities: {
    tokenType: GitHubTokenMetadata["tokenType"];
    hasRepoScope: boolean;
    hasWorkflowScope: boolean;
    scopeAmbiguous: boolean;
  };
}

export interface HarnessRepoProvisioningApplyResult {
  state: HarnessProvisioningState;
  harnessDispatchRepo: string | null;
  message: string;
  recoverable: boolean;
  persisted: boolean;
  operationId?: string;
  phase?: string;
  uiPhaseLabel?: string;
  timings?: HarnessRepoProvisioningTimings;
}

export interface HarnessRepoProvisioningTimings {
  authenticationMs?: number;
  snapshotProvisioning?: SnapshotProvisioningTimings;
  remoteVerificationMs?: number;
  localPersistenceMs?: number;
}

function elapsedHarnessProvisioningMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function buildFingerprint(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

function destinationSlug(login: string): string {
  return `${login}/${HARNESS_DEFAULT_DESTINATION_REPO_NAME}`;
}

type SnapshotPreviewOk = Extract<
  Awaited<ReturnType<typeof loadEmbeddedWorkspaceSnapshot>>,
  { ok: true }
>;

function emptySnapshotPreviewFields(): Pick<
  HarnessRepoProvisioningPreview,
  | "packageName"
  | "packageVersion"
  | "sourceRepository"
  | "sourceCommit"
  | "snapshotContentId"
  | "snapshotFingerprint"
  | "templateContentId"
> {
  return {
    packageName: "p-dev-harness",
    packageVersion: "",
    sourceRepository: "",
    sourceCommit: "",
    snapshotContentId: null,
    snapshotFingerprint: null,
    templateContentId: null,
  };
}

function snapshotPreviewFields(
  snapshot: SnapshotPreviewOk | null,
  templateContentIdOverride?: string | null,
): Pick<
  HarnessRepoProvisioningPreview,
  | "packageName"
  | "packageVersion"
  | "sourceRepository"
  | "sourceCommit"
  | "snapshotContentId"
  | "snapshotFingerprint"
  | "templateContentId"
> {
  if (!snapshot) {
    return emptySnapshotPreviewFields();
  }
  const snapshotContentId = snapshot.manifest.snapshotContentId;
  return {
    packageName: snapshot.manifest.packageName,
    packageVersion: snapshot.manifest.packageVersion,
    sourceRepository: snapshot.manifest.sourceRepository,
    sourceCommit: snapshot.manifest.sourceCommit,
    snapshotContentId,
    snapshotFingerprint: snapshot.fingerprint,
    templateContentId: templateContentIdOverride ?? snapshotContentId,
  };
}

function readSavedRepositoryId(
  existingEnv: Awaited<ReturnType<typeof readExistingEnvFile>>,
): number | null {
  const raw = existingEnv?.values.GITHUB_DISPATCH_REPOSITORY_ID?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function buildSnapshotPendingValidationContext(
  snapshot: SnapshotPreviewOk,
  input: {
    operationId?: string;
    authenticatedUserId: number;
    authenticatedLogin: string;
    targetOwner: string;
    targetRepo: string;
    previewFingerprint?: string;
  },
) {
  return buildPendingValidationContext({
    operationId: input.operationId,
    authenticatedUserId: input.authenticatedUserId,
    authenticatedLogin: input.authenticatedLogin,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    packageName: snapshot.manifest.packageName,
    packageVersion: snapshot.manifest.packageVersion,
    sourceRepository: snapshot.manifest.sourceRepository,
    sourceCommit: snapshot.manifest.sourceCommit,
    manifestSchemaVersion: snapshot.manifest.schemaVersion,
    snapshotContentId: snapshot.manifest.snapshotContentId,
    snapshotSha256: snapshot.manifest.snapshotSha256,
    snapshotGitTreeSha1: snapshot.manifest.gitRootTreeSha1,
    previewFingerprint: input.previewFingerprint,
  });
}

function buildProvisioningPreviewFingerprint(input: {
  operationId: string;
  user: { id: number; login: string };
  destination: string;
  snapshotPreview: SnapshotPreviewOk;
  classification: HarnessProvisioningClassification;
  envBaseline: string;
  pDevVersion: string;
  resumedFromPending: boolean;
  creationPreviewFingerprint: string | null;
}): string {
  const context = buildHarnessProvisioningPreviewContext({
    operationId: input.operationId,
    user: input.user,
    destination: input.destination,
    manifest: input.snapshotPreview.manifest,
    snapshotFingerprint: input.snapshotPreview.fingerprint,
    classification: input.classification,
    envBaseline: input.envBaseline,
    pDevVersion: input.pDevVersion,
    resumedFromPending: input.resumedFromPending,
    creationPreviewFingerprint: input.creationPreviewFingerprint,
  });
  return serializeHarnessProvisioningPreviewContext(context);
}

async function resolveProvisioningOperation(input: {
  cwd?: string;
  requestedOperationId?: string;
  user: { id: number; login: string };
  snapshotPreview: SnapshotPreviewOk;
}): Promise<
  | {
      ok: true;
      operationId: string;
      resumedFromPending: boolean;
      creationPreviewFingerprint: string | null;
      pending: HarnessProvisioningPendingState | null;
    }
  | { ok: false; state: HarnessProvisioningState; message: string }
> {
  const validationContext = buildSnapshotPendingValidationContext(
    input.snapshotPreview,
    {
      authenticatedUserId: input.user.id,
      authenticatedLogin: input.user.login,
      targetOwner: input.user.login,
      targetRepo: HARNESS_DEFAULT_DESTINATION_REPO_NAME,
    },
  );

  if (input.requestedOperationId) {
    const pending = await readHarnessProvisioningPendingState(input.cwd);
    if (pending && pending.operationId !== input.requestedOperationId) {
      return {
        ok: false,
        state: "concurrent-request-recovered",
        message:
          "Another provisioning operation is already in progress for this workspace.",
      };
    }
    return {
      ok: true,
      operationId: input.requestedOperationId,
      resumedFromPending: Boolean(pending),
      creationPreviewFingerprint: pending?.previewFingerprint ?? null,
      pending,
    };
  }

  const pending = await readHarnessProvisioningPendingState(input.cwd);
  if (!pending) {
    return {
      ok: true,
      operationId: randomUUID(),
      resumedFromPending: false,
      creationPreviewFingerprint: null,
      pending: null,
    };
  }

  const validation = validatePendingProvisioningState(pending, validationContext);
  if (!validation.ok) {
    return {
      ok: false,
      state: "same-name-unmanaged-collision",
      message: validation.reason,
    };
  }

  return {
    ok: true,
    operationId: pending.operationId,
    resumedFromPending: true,
    creationPreviewFingerprint: pending.previewFingerprint,
    pending,
  };
}

async function validateExplicitPackagedRepo(
  provider: GitHubHarnessProvisioningProvider,
  repoSlug: string,
  savedRepositoryId: number | null,
): Promise<
  | {
      ok: true;
      repoSlug: string;
      repositoryId: number;
      marker: ReturnType<typeof parseHarnessManagedRepoMarkerJson> & {
        ok: true;
      };
    }
  | { ok: false; state: HarnessProvisioningState; message: string }
> {
  if (repoSlug === HARNESS_LEGACY_PUBLIC_SOURCE_REPO) {
    return {
      ok: false,
      state: "explicit-packaged-repo-legacy-source",
      message:
        "Saved harness repo points at the public source repo. Use advanced recovery to adopt a private managed workspace.",
    };
  }

  let resolvedSlug = normalizeRepoSlug(repoSlug);
  let metadata = null as Awaited<
    ReturnType<GitHubHarnessProvisioningProvider["getRepositoryMetadata"]>
  >;

  if (savedRepositoryId) {
    metadata = await provider.getRepositoryMetadataById(savedRepositoryId);
    if (!metadata) {
      return {
        ok: false,
        state: "explicit-packaged-repo-invalid",
        message: `Saved harness repository ID ${savedRepositoryId} is missing or inaccessible.`,
      };
    }
    resolvedSlug = normalizeRepoSlug(`${metadata.owner}/${metadata.repo}`);
    if (
      normalizeRepoSlug(repoSlug) !== resolvedSlug &&
      savedRepositoryId !== metadata.repositoryId
    ) {
      return {
        ok: false,
        state: "explicit-packaged-repo-invalid",
        message: `Saved harness repo ${repoSlug} does not match repository ID ${savedRepositoryId}.`,
      };
    }
  } else {
    const { owner, repo } = parseRepoSlug(resolvedSlug);
    metadata = await provider.getRepositoryMetadata(owner, repo);
  }

  if (!metadata) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: `Saved harness repo ${repoSlug} is missing or inaccessible.`,
    };
  }
  if (savedRepositoryId && metadata.repositoryId !== savedRepositoryId) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: `Saved harness repository ID does not match GitHub metadata for ${resolvedSlug}.`,
    };
  }
  if (!metadata.private || metadata.visibility !== "private") {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: `Saved harness repo ${resolvedSlug} must be private in packaged mode.`,
    };
  }
  if (!metadata.permissions.admin) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: `Saved harness repo ${resolvedSlug} requires admin access.`,
    };
  }

  const markerRaw = await provider.readRepositoryFileContent(
    metadata.owner,
    metadata.repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    metadata.defaultBranch,
  );
  if (!markerRaw) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: `Saved harness repo ${resolvedSlug} is missing a compatible managed marker.`,
    };
  }
  const marker = parseHarnessManagedRepoMarkerJson(markerRaw);
  if (!marker.ok) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: marker.reason,
    };
  }
  const reconnect = validateManagedMarkerForReconnect(
    marker.marker,
    resolvedSlug,
    { repositoryId: metadata.repositoryId },
  );
  if (!reconnect.ok) {
    return {
      ok: false,
      state: "explicit-packaged-repo-invalid",
      message: reconnect.reason,
    };
  }

  return {
    ok: true,
    repoSlug: resolvedSlug,
    repositoryId: metadata.repositoryId,
    marker,
  };
}

type DestinationClassification =
  | { kind: "absent" }
  | { kind: "valid-managed"; repoSlug: string; repositoryId: number }
  | { kind: "public-collision" }
  | { kind: "unmanaged-collision" }
  | { kind: "malformed-marker"; reason: string }
  | { kind: "snapshot-only-without-pending" }
  | { kind: "snapshot-only-with-pending" };

async function classifyDestinationRepo(
  provider: GitHubHarnessProvisioningProvider,
  user: { id: number; login: string },
  cwd?: string,
  snapshotPreview?: SnapshotPreviewOk,
): Promise<DestinationClassification> {
  const repoSlug = destinationSlug(user.login);
  const { owner, repo } = parseRepoSlug(repoSlug);
  const metadata = await provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    return { kind: "absent" };
  }
  if (!metadata.private || metadata.visibility !== "private") {
    return { kind: "public-collision" };
  }
  if (!metadata.permissions.admin) {
    return { kind: "unmanaged-collision" };
  }

  const markerRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    metadata.defaultBranch,
  );
  if (markerRaw) {
    const marker = parseHarnessManagedRepoMarkerJson(markerRaw);
    if (!marker.ok) {
      return { kind: "malformed-marker", reason: marker.reason };
    }
    const reconnect = validateManagedMarkerForReconnect(marker.marker, repoSlug, {
      repositoryId: metadata.repositoryId,
    });
    if (!reconnect.ok) {
      return { kind: "malformed-marker", reason: reconnect.reason };
    }
    return {
      kind: "valid-managed",
      repoSlug,
      repositoryId: metadata.repositoryId,
    };
  }

  const pending = await readHarnessProvisioningPendingState(cwd);
  if (pending && snapshotPreview) {
    const validation = validatePendingProvisioningState(
      pending,
      buildSnapshotPendingValidationContext(snapshotPreview, {
        authenticatedUserId: user.id,
        authenticatedLogin: user.login,
        targetOwner: user.login,
        targetRepo: HARNESS_DEFAULT_DESTINATION_REPO_NAME,
      }),
    );
    if (validation.ok) {
      return { kind: "snapshot-only-with-pending" };
    }
    if (!validation.ok) {
      return { kind: "unmanaged-collision" };
    }
  }

  const templateRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_TEMPLATE_IDENTITY_FILE,
    metadata.defaultBranch,
  );
  if (templateRaw) {
    const parsedTemplate = parseHarnessTemplateIdentityJson(templateRaw);
    if (!parsedTemplate.ok) {
      return {
        kind: "malformed-marker",
        reason: `Generated repository template identity is invalid: ${parsedTemplate.reason}`,
      };
    }
    return { kind: "snapshot-only-without-pending" };
  }

  return { kind: "unmanaged-collision" };
}

function buildSnapshotPendingState(input: {
  operationId: string;
  user: { id: number; login: string };
  snapshotPreview: SnapshotPreviewOk;
  previewFingerprint: string;
  pending?: HarnessProvisioningPendingState | null;
  phase?: HarnessProvisioningPhase;
  repositoryId?: number;
  defaultBranch?: string;
  initializedCommitSha?: string;
  snapshotCommitSha?: string;
  markerCommitSha?: string;
}): HarnessProvisioningPendingState {
  const manifest = input.snapshotPreview.manifest;
  return {
    operationId: input.operationId,
    authenticatedUserId: input.user.id,
    authenticatedLogin: input.user.login,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    sourceRepository: manifest.sourceRepository,
    sourceCommit: manifest.sourceCommit,
    manifestSchemaVersion: manifest.schemaVersion,
    snapshotContentId: manifest.snapshotContentId,
    snapshotSha256: manifest.snapshotSha256,
    snapshotGitTreeSha1: manifest.gitRootTreeSha1,
    targetOwner: input.user.login,
    targetRepo: HARNESS_DEFAULT_DESTINATION_REPO_NAME,
    previewFingerprint: input.previewFingerprint,
    startedAt: input.pending?.startedAt ?? new Date().toISOString(),
    phase: input.phase ?? input.pending?.phase,
    repositoryId: input.repositoryId ?? input.pending?.repositoryId,
    defaultBranch: input.defaultBranch ?? input.pending?.defaultBranch,
    initializedCommitSha:
      input.initializedCommitSha ?? input.pending?.initializedCommitSha,
    snapshotCommitSha: input.snapshotCommitSha ?? input.pending?.snapshotCommitSha,
    markerCommitSha: input.markerCommitSha ?? input.pending?.markerCommitSha,
  };
}

async function finalizeLegacyTemplateManagedMarker(
  provider: GitHubHarnessProvisioningProvider,
  input: {
    repoSlug: string;
    repositoryId: number;
    defaultBranch: string;
    templateIdentity: ReturnType<typeof parseHarnessTemplateIdentityJson> & {
      ok: true;
    };
    templateHeadSha: string;
    operationId: string;
    user: { id: number; login: string };
    pDevVersion: string;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { owner, repo } = parseRepoSlug(input.repoSlug);
  const metadata = await provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    return {
      ok: false,
      message: `Generated harness workspace ${input.repoSlug} is not accessible for marker finalization.`,
    };
  }
  if (metadata.repositoryId !== input.repositoryId) {
    return {
      ok: false,
      message: `Generated harness workspace repository ID mismatch for ${input.repoSlug}.`,
    };
  }
  const expectedMarker = buildHarnessManagedRepoMarker({
    repository: input.repoSlug,
    repositoryId: input.repositoryId,
    templateIdentity: input.templateIdentity.identity,
    defaultBranch: input.defaultBranch,
    sourceHeadSha: input.templateHeadSha,
    operationId: input.operationId,
    createdByGithubUserId: input.user.id,
    createdByLogin: input.user.login,
    pDevVersion: input.pDevVersion,
  });
  const existingRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    input.defaultBranch,
  );
  if (existingRaw) {
    const existing = parseHarnessManagedRepoMarkerJson(existingRaw);
    if (!existing.ok) {
      return { ok: false, message: existing.reason };
    }
    if (
      markersAreEquivalentForOperation(existing.marker, expectedMarker) ||
      markerValidForExistingWorkspace(existing.marker, input.repoSlug, {
        repositoryId: input.repositoryId,
      })
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      message:
        "Existing managed marker belongs to a different operation or repository.",
    };
  }

  try {
    await provider.writeRepositoryFile({
      owner,
      repo,
      path: HARNESS_MANAGED_REPO_MARKER_FILE,
      branch: input.defaultBranch,
      message: "Initialize p-dev managed harness workspace marker",
      content: `${JSON.stringify(expectedMarker, null, 2)}\n`,
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to write managed harness workspace marker.",
    };
  }
  return { ok: true };
}

async function readLegacyTemplateIdentityAtHead(
  provider: GitHubHarnessProvisioningProvider,
  repoSlug: string,
): Promise<
  | {
      ok: true;
      defaultBranch: string;
      repositoryId: number;
      identity: ReturnType<typeof parseHarnessTemplateIdentityJson> & {
        ok: true;
      };
    }
  | { ok: false; message: string }
> {
  const { owner, repo } = parseRepoSlug(repoSlug);
  const metadata = await provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    return {
      ok: false,
      message: `Harness workspace ${repoSlug} is not accessible.`,
    };
  }
  const identityRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_TEMPLATE_IDENTITY_FILE,
    metadata.defaultBranch,
  );
  if (!identityRaw) {
    return {
      ok: false,
      message: "Legacy generated repository template identity is missing.",
    };
  }
  const parsed = parseHarnessTemplateIdentityJson(identityRaw);
  if (!parsed.ok) {
    return { ok: false, message: parsed.reason };
  }
  return {
    ok: true,
    defaultBranch: metadata.defaultBranch,
    repositoryId: metadata.repositoryId,
    identity: parsed,
  };
}

export async function loadHarnessRepoProvisioningSummary(options: {
  cwd?: string;
  provider?: GitHubHarnessProvisioningProvider;
}): Promise<HarnessRepoProvisioningSummary> {
  const runtimeMode: HarnessRepoProvisioningSummary["runtimeMode"] =
    isPackagedPDevRuntime()
      ? "packaged"
      : process.env.P_DEV_RUNTIME_MODE?.trim()
        ? "source"
        : "unknown";

  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const explicitRepo = existingEnv?.values.GITHUB_DISPATCH_REPOSITORY?.trim();
  const pending = await readHarnessProvisioningPendingState(options.cwd);

  const base = {
    runtimeMode,
    harnessDispatchRepo: explicitRepo ?? null,
    authenticatedLogin: null as string | null,
    verifiedSavedRepo: false,
    connectedAutomatically: false,
  };

  if (!isPackagedPDevRuntime()) {
    const trusted = await resolveStep1TrustedHarnessRepo({
      cwd: options.cwd,
      explicitRepo,
    });
    if (trusted) {
      return {
        ...base,
        harnessDispatchRepo: trusted.repo,
        verifiedSavedRepo: true,
        eligible: false,
        state: "skipped-source-mode",
        message: step1TrustedHarnessRepoMessage(trusted),
        recoverable: false,
      };
    }

    return {
      ...base,
      eligible: false,
      state: runtimeMode === "source" ? "skipped-source-mode" : "skipped-not-packaged",
      message:
        runtimeMode === "source"
          ? "Source mode does not auto-provision a harness workspace."
          : "Packaged runtime mode is not active.",
      recoverable: false,
    };
  }

  if (pending) {
    return {
      ...base,
      eligible: true,
      state: "repo-created-pending-verification",
      message:
        "Harness workspace provisioning is incomplete. Retry Step 1 Continue to resume.",
      recoverable: true,
    };
  }

  if (!explicitRepo) {
    return {
      ...base,
      eligible: true,
      state: "repo-absent",
      message: "Packaged workspace provisioning has not completed yet.",
      recoverable: true,
    };
  }

  if (!options.provider) {
    return {
      ...base,
      eligible: true,
      state: "explicit-repo-present",
      message: `Saved harness workspace ${explicitRepo} requires server validation.`,
      recoverable: true,
    };
  }

  const capabilities = await options.provider.inspectTokenCapabilities();
  const validated = await validateExplicitPackagedRepo(
    options.provider,
    explicitRepo,
    readSavedRepositoryId(existingEnv),
  );
  if (!validated.ok) {
    return {
      ...base,
      eligible: true,
      state: validated.state,
      authenticatedLogin: capabilities.login,
      message: validated.message,
      recoverable: true,
    };
  }

  const isDefaultDestination =
    explicitRepo === destinationSlug(capabilities.login) ||
    explicitRepo === destinationSlug(validated.marker.marker.createdByLogin ?? "");

  return {
    ...base,
    eligible: true,
    state: "verified-and-persisted",
    harnessDispatchRepo: explicitRepo,
    authenticatedLogin: capabilities.login,
    message: `Connected to validated harness workspace ${explicitRepo}.`,
    recoverable: false,
    verifiedSavedRepo: true,
    connectedAutomatically:
      isDefaultDestination && Boolean(validated.marker.marker.operationId),
  };
}

export async function previewHarnessRepoProvisioning(options: {
  cwd?: string;
  provider: GitHubHarnessProvisioningProvider;
  operationId?: string;
  moduleUrl?: string;
}): Promise<HarnessRepoProvisioningPreview> {
  const basePreview = {
    creationPreviewFingerprint: null as string | null,
    resumedFromPending: false,
    harnessDispatchRepo: null as string | null,
    authenticatedLogin: null as string | null,
    recoverable: false,
    willCreateRepository: false,
    tokenCapabilities: {
      tokenType: "unknown" as GitHubTokenMetadata["tokenType"],
      hasRepoScope: false,
      hasWorkflowScope: false,
      scopeAmbiguous: true,
    },
  };

  if (!isPackagedPDevRuntime()) {
    return {
      state: "skipped-not-packaged",
      fingerprint: buildFingerprint({ action: "preview", skipped: true }),
      operationId: options.operationId ?? randomUUID(),
      message: "Packaged runtime mode is not active.",
      ...basePreview,
      ...emptySnapshotPreviewFields(),
    };
  }

  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const explicitRepo = existingEnv?.values.GITHUB_DISPATCH_REPOSITORY?.trim();
  const pDevVersion = resolveHarnessPackageVersion();

  const capabilities = await options.provider.inspectTokenCapabilities();
  const tokenMetadata: GitHubTokenMetadata = {
    login: capabilities.login,
    tokenType: capabilities.tokenType,
    oauthScopes: [],
    hasRepoScope: capabilities.hasRepoScope,
    hasWorkflowScope: capabilities.hasWorkflowScope,
  };
  const capabilityCheck = assessPackagedProvisioningTokenCapabilities({
    ...tokenMetadata,
    oauthScopes:
      capabilities.scopeAmbiguous || capabilities.tokenType !== "classic"
        ? []
        : [
            ...(capabilities.hasRepoScope ? ["repo"] : []),
            ...(capabilities.hasWorkflowScope ? ["workflow"] : []),
          ],
  });

  if (capabilities.scopeAmbiguous) {
    const operationId = options.operationId ?? randomUUID();
    return {
      state: "token-scope-ambiguous",
      fingerprint: buildFingerprint({ action: "preview", operationId }),
      operationId,
      message: capabilityCheck.ok
        ? "Token scope metadata is ambiguous."
        : capabilityCheck.message,
      ...basePreview,
      recoverable: true,
      harnessDispatchRepo: explicitRepo ?? null,
      authenticatedLogin: capabilities.login,
      ...emptySnapshotPreviewFields(),
      tokenCapabilities: {
        tokenType: capabilities.tokenType,
        hasRepoScope: capabilities.hasRepoScope,
        hasWorkflowScope: capabilities.hasWorkflowScope,
        scopeAmbiguous: capabilities.scopeAmbiguous,
      },
    };
  }

  if (!capabilityCheck.ok) {
    const state =
      capabilities.tokenType === "fine-grained"
        ? "token-unsupported"
        : capabilities.tokenType === "unknown"
          ? "token-scope-ambiguous"
          : "token-insufficient";
    const operationId = options.operationId ?? randomUUID();
    return {
      state,
      fingerprint: buildFingerprint({ action: "preview", operationId }),
      operationId,
      message: capabilityCheck.message,
      ...basePreview,
      recoverable: true,
      harnessDispatchRepo: explicitRepo ?? null,
      authenticatedLogin: capabilities.login,
      ...emptySnapshotPreviewFields(),
      tokenCapabilities: {
        tokenType: capabilities.tokenType,
        hasRepoScope: capabilities.hasRepoScope,
        hasWorkflowScope: capabilities.hasWorkflowScope,
        scopeAmbiguous: capabilities.scopeAmbiguous,
      },
    };
  }

  const user = await options.provider.resolveAuthenticatedUser();

  if (explicitRepo) {
    const operationId = options.operationId ?? randomUUID();
    const explicit = await validateExplicitPackagedRepo(
      options.provider,
      explicitRepo,
      readSavedRepositoryId(existingEnv),
    );
    const fingerprint = buildFingerprint({
      action: "preview",
      operationId,
      authenticatedLogin: user.login,
      explicitRepo,
      pDevVersion,
    });
    if (!explicit.ok) {
      return {
        state: explicit.state,
        fingerprint,
        operationId,
        message: explicit.message,
        ...basePreview,
        recoverable: true,
        harnessDispatchRepo: explicitRepo,
        authenticatedLogin: user.login,
        ...emptySnapshotPreviewFields(),
        tokenCapabilities: {
          tokenType: capabilities.tokenType,
          hasRepoScope: capabilities.hasRepoScope,
          hasWorkflowScope: capabilities.hasWorkflowScope,
          scopeAmbiguous: capabilities.scopeAmbiguous,
        },
      };
    }

    const legacyTemplateContentId =
      explicit.marker.marker.createdFromTemplate?.templateContentId ?? null;

    return {
      state: "explicit-repo-present",
      fingerprint,
      operationId,
      message: `Reconnecting to saved harness workspace ${explicitRepo}.`,
      ...basePreview,
      harnessDispatchRepo: explicitRepo,
      authenticatedLogin: user.login,
      ...snapshotPreviewFields(null, legacyTemplateContentId),
      tokenCapabilities: {
        tokenType: capabilities.tokenType,
        hasRepoScope: capabilities.hasRepoScope,
        hasWorkflowScope: capabilities.hasWorkflowScope,
        scopeAmbiguous: capabilities.scopeAmbiguous,
      },
    };
  }

  const snapshotPreview = await loadEmbeddedWorkspaceSnapshot(
    options.moduleUrl ?? import.meta.url,
  );
  if (!snapshotPreview.ok) {
    const operationId = options.operationId ?? randomUUID();
    return {
      state: snapshotPreview.state,
      fingerprint: buildFingerprint({ action: "preview", operationId }),
      operationId,
      message: snapshotPreview.message,
      ...basePreview,
      authenticatedLogin: user.login,
      ...emptySnapshotPreviewFields(),
      tokenCapabilities: {
        tokenType: capabilities.tokenType,
        hasRepoScope: capabilities.hasRepoScope,
        hasWorkflowScope: capabilities.hasWorkflowScope,
        scopeAmbiguous: capabilities.scopeAmbiguous,
      },
    };
  }

  const resolvedOperation = await resolveProvisioningOperation({
    cwd: options.cwd,
    requestedOperationId: options.operationId,
    user,
    snapshotPreview,
  });
  if (!resolvedOperation.ok) {
    return {
      state: resolvedOperation.state,
      fingerprint: buildFingerprint({
        action: "preview",
        conflict: resolvedOperation.message,
      }),
      operationId: options.operationId ?? randomUUID(),
      message: resolvedOperation.message,
      ...basePreview,
      recoverable: true,
      authenticatedLogin: user.login,
      ...snapshotPreviewFields(snapshotPreview),
      tokenCapabilities: {
        tokenType: capabilities.tokenType,
        hasRepoScope: capabilities.hasRepoScope,
        hasWorkflowScope: capabilities.hasWorkflowScope,
        scopeAmbiguous: capabilities.scopeAmbiguous,
      },
    };
  }

  const {
    operationId,
    resumedFromPending,
    creationPreviewFingerprint,
  } = resolvedOperation;

  const destination = destinationSlug(user.login);
  const classification = await classifyDestinationRepo(
    options.provider,
    user,
    options.cwd,
    snapshotPreview,
  );

  let state: HarnessProvisioningState = "snapshot-preview-ready";
  let message = `p-dev will create or reconnect ${destination} as your private harness workspace.`;
  let willCreateRepository = false;

  switch (classification.kind) {
    case "absent":
      state = "repo-absent";
      willCreateRepository = true;
      message = `p-dev will create private harness workspace ${destination} from the packaged workspace snapshot.`;
      break;
    case "valid-managed":
      state = "valid-existing-managed-repo";
      message = `Reconnecting to existing managed harness workspace ${destination}.`;
      break;
    case "public-collision":
      state = "same-name-public-collision";
      message = `${destination} exists but is not private. p-dev will not change it automatically.`;
      break;
    case "unmanaged-collision":
      state = "same-name-unmanaged-collision";
      message = `${destination} exists without a compatible managed marker.`;
      break;
    case "malformed-marker":
      state = "same-name-malformed-marker";
      message = classification.reason;
      break;
    case "snapshot-only-without-pending":
      state = "same-name-snapshot-only-without-pending";
      message = `${destination} looks like an unmanaged generated repo.`;
      break;
    case "snapshot-only-with-pending":
      state = "same-name-snapshot-only-with-pending";
      message = `Resuming snapshot provisioning for ${destination}.`;
      break;
  }

  const fingerprint = buildProvisioningPreviewFingerprint({
    operationId,
    user,
    destination,
    snapshotPreview,
    classification: classification.kind,
    envBaseline: existingEnv?.values.GITHUB_DISPATCH_REPOSITORY ?? "",
    pDevVersion,
    resumedFromPending,
    creationPreviewFingerprint,
  });

  return {
    state,
    fingerprint,
    operationId,
    creationPreviewFingerprint,
    resumedFromPending,
    harnessDispatchRepo:
      classification.kind === "valid-managed" ? destination : null,
    authenticatedLogin: user.login,
    message,
    recoverable:
      state === "repo-absent" ||
      state === "valid-existing-managed-repo" ||
      state === "same-name-snapshot-only-with-pending",
    willCreateRepository,
    ...snapshotPreviewFields(snapshotPreview),
    tokenCapabilities: {
      tokenType: capabilities.tokenType,
      hasRepoScope: capabilities.hasRepoScope,
      hasWorkflowScope: capabilities.hasWorkflowScope,
      scopeAmbiguous: capabilities.scopeAmbiguous,
    },
  };
}

export async function applyHarnessRepoProvisioning(options: {
  cwd?: string;
  provider: GitHubHarnessProvisioningProvider;
  confirmed: boolean;
  fingerprint: string;
  operationId: string;
  moduleUrl?: string;
}): Promise<HarnessRepoProvisioningApplyResult> {
  return withHarnessProvisioningMutex(
    resolveLocalFilePaths(options.cwd).cwd,
    async () => applyHarnessRepoProvisioningLocked(options),
  );
}

async function applyHarnessRepoProvisioningLocked(options: {
  cwd?: string;
  provider: GitHubHarnessProvisioningProvider;
  confirmed: boolean;
  fingerprint: string;
  operationId: string;
  moduleUrl?: string;
}): Promise<HarnessRepoProvisioningApplyResult> {
  const preview = await previewHarnessRepoProvisioning({
    cwd: options.cwd,
    provider: options.provider,
    operationId: options.operationId,
    moduleUrl: options.moduleUrl,
  });

  if (!options.confirmed) {
    return {
      state: preview.state,
      harnessDispatchRepo: preview.harnessDispatchRepo,
      message: "Confirmation is required before provisioning.",
      recoverable: true,
      persisted: false,
    };
  }

  if (preview.fingerprint !== options.fingerprint) {
    return {
      state: "snapshot-preview-stale",
      harnessDispatchRepo: preview.harnessDispatchRepo,
      message: "Provisioning preview is stale. Retry Step 1 Continue.",
      recoverable: true,
      persisted: false,
    };
  }

  if (
    preview.state === "skipped-not-packaged" ||
    preview.state === "token-unsupported" ||
    preview.state === "token-insufficient" ||
    preview.state === "token-scope-ambiguous" ||
    preview.state === "snapshot-unavailable" ||
    preview.state === "snapshot-manifest-missing" ||
    preview.state === "snapshot-manifest-invalid" ||
    preview.state === "snapshot-incompatible" ||
    preview.state === "snapshot-tampered" ||
    preview.state === "same-name-public-collision" ||
    preview.state === "same-name-unmanaged-collision" ||
    preview.state === "same-name-malformed-marker" ||
    preview.state === "same-name-snapshot-only-without-pending" ||
    preview.state === "explicit-packaged-repo-invalid" ||
    preview.state === "explicit-packaged-repo-legacy-source"
  ) {
    return {
      state: preview.state,
      harnessDispatchRepo: preview.harnessDispatchRepo,
      message: preview.message,
      recoverable: preview.recoverable,
      persisted: false,
    };
  }

  const authenticationStartedAt = performance.now();
  const user = await options.provider.resolveAuthenticatedUser();
  const applyTimings: HarnessRepoProvisioningTimings = {
    authenticationMs: elapsedHarnessProvisioningMs(authenticationStartedAt),
  };
  const pDevVersion = resolveHarnessPackageVersion();
  const paths = resolveLocalFilePaths(options.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const explicitRepo = existingEnv?.values.GITHUB_DISPATCH_REPOSITORY?.trim();

  if (explicitRepo) {
    const explicit = await validateExplicitPackagedRepo(
      options.provider,
      explicitRepo,
      readSavedRepositoryId(existingEnv),
    );
    if (!explicit.ok) {
      return {
        state: explicit.state,
        harnessDispatchRepo: explicitRepo,
        message: explicit.message,
        recoverable: true,
        persisted: false,
      };
    }

    const persist = await persistGithubDispatchRepository({
      cwd: options.cwd,
      githubDispatchRepository: explicit.repoSlug,
      githubDispatchRepositoryId: explicit.repositoryId,
    });
    if (persist.outcome !== "changed" && persist.outcome !== "skipped") {
      return {
        state: "created-but-persistence-failed",
        harnessDispatchRepo: explicit.repoSlug,
        message: persist.reason ?? "Failed to persist GITHUB_DISPATCH_REPOSITORY.",
        recoverable: true,
        persisted: false,
      };
    }
    await clearHarnessProvisioningPendingState(options.cwd);
    return {
      state: "verified-and-persisted",
      harnessDispatchRepo: explicit.repoSlug,
      message: `Connected to saved harness workspace ${explicit.repoSlug}.`,
      recoverable: false,
      persisted: true,
    };
  }

  const snapshotPreview = await loadEmbeddedWorkspaceSnapshot(
    options.moduleUrl ?? import.meta.url,
  );
  if (!snapshotPreview.ok) {
    return {
      state: snapshotPreview.state,
      harnessDispatchRepo: null,
      message: snapshotPreview.message,
      recoverable: false,
      persisted: false,
    };
  }

  const classification = await classifyDestinationRepo(
    options.provider,
    user,
    options.cwd,
    snapshotPreview,
  );

  const currentContext = buildHarnessProvisioningPreviewContext({
    operationId: options.operationId,
    user,
    destination: destinationSlug(user.login),
    manifest: snapshotPreview.manifest,
    snapshotFingerprint: snapshotPreview.fingerprint,
    classification: classification.kind as HarnessProvisioningClassification,
    envBaseline: existingEnv?.values.GITHUB_DISPATCH_REPOSITORY ?? "",
    pDevVersion,
    resumedFromPending: preview.resumedFromPending,
    creationPreviewFingerprint: preview.creationPreviewFingerprint,
  });
  const contextValidation = validateSubmittedHarnessProvisioningFingerprint({
    submittedFingerprint: options.fingerprint,
    currentContext,
  });
  if (!contextValidation.ok) {
    return {
      state: "snapshot-preview-stale",
      harnessDispatchRepo: null,
      message: contextValidation.message,
      recoverable: true,
      persisted: false,
    };
  }

  let targetRepo = destinationSlug(user.login);
  let targetRepositoryId: number | undefined =
    classification.kind === "valid-managed"
      ? classification.repositoryId
      : undefined;

  const pending = await readHarnessProvisioningPendingState(options.cwd);
  if (preview.resumedFromPending) {
    if (!pending || !preview.creationPreviewFingerprint) {
      return {
        state: "same-name-snapshot-only-without-pending",
        harnessDispatchRepo: destinationSlug(user.login),
        message:
          "Matching local pending provisioning evidence is required to resume.",
        recoverable: true,
        persisted: false,
      };
    }
    const pendingValidation = validatePendingProvisioningState(
      pending,
      buildSnapshotPendingValidationContext(snapshotPreview, {
        operationId: options.operationId,
        authenticatedUserId: user.id,
        authenticatedLogin: user.login,
        targetOwner: user.login,
        targetRepo: HARNESS_DEFAULT_DESTINATION_REPO_NAME,
        previewFingerprint: preview.creationPreviewFingerprint,
      }),
    );
    if (!pendingValidation.ok) {
      return {
        state: "same-name-unmanaged-collision",
        harnessDispatchRepo: destinationSlug(user.login),
        message: pendingValidation.reason,
        recoverable: true,
        persisted: false,
      };
    }
  } else if (
    pending &&
    preview.state !== "valid-existing-managed-repo" &&
    classification.kind !== "valid-managed"
  ) {
    return {
      state: "concurrent-request-recovered",
      harnessDispatchRepo: null,
      message:
        "Another provisioning operation is already in progress for this workspace.",
      recoverable: true,
      persisted: false,
    };
  }

  const creationFingerprint =
    preview.creationPreviewFingerprint ?? options.fingerprint;
  let activePending = pending;
  let requiresSnapshotVerification = false;

  if (classification.kind === "valid-managed") {
    targetRepo = classification.repoSlug;
  } else if (
    classification.kind === "absent" ||
    classification.kind === "snapshot-only-with-pending"
  ) {
    const legacyTemplateIdentity =
      classification.kind === "snapshot-only-with-pending"
        ? await readLegacyTemplateIdentityAtHead(options.provider, targetRepo)
        : null;

    if (
      classification.kind === "snapshot-only-with-pending" &&
      legacyTemplateIdentity?.ok
    ) {
      const { owner, repo } = parseRepoSlug(targetRepo);
      const legacyHeadSha = await options.provider.getRepositoryDefaultBranchHead(
        owner,
        repo,
        legacyTemplateIdentity.defaultBranch,
      );
      const markerResult = await finalizeLegacyTemplateManagedMarker(
        options.provider,
        {
          repoSlug: targetRepo,
          repositoryId: legacyTemplateIdentity.repositoryId,
          defaultBranch: legacyTemplateIdentity.defaultBranch,
          templateIdentity: legacyTemplateIdentity.identity,
          templateHeadSha: legacyHeadSha,
          operationId: options.operationId,
          user,
          pDevVersion,
        },
      );
      if (!markerResult.ok) {
        return {
          state: "marker-write-pending",
          harnessDispatchRepo: targetRepo,
          message: markerResult.message,
          recoverable: true,
          persisted: false,
        };
      }
      targetRepositoryId = legacyTemplateIdentity.repositoryId;
    } else {
      if (classification.kind === "absent" && !preview.resumedFromPending) {
        await writeHarnessProvisioningPendingStateAtomic(
          buildSnapshotPendingState({
            operationId: options.operationId,
            user,
            snapshotPreview,
            previewFingerprint: creationFingerprint,
          }),
          options.cwd,
        );
        activePending = await readHarnessProvisioningPendingState(options.cwd);
      }

      let provisionResult:
        | Awaited<ReturnType<typeof provisionHarnessWorkspaceFromSnapshot>>
        | undefined;
      try {
        const progressStartedAt =
          activePending?.startedAt ?? new Date().toISOString();
        let phaseStartedAt = new Date().toISOString();
        let lastProgressPhase: string | undefined;
        provisionResult = await provisionHarnessWorkspaceFromSnapshot({
          provider: options.provider,
          user,
          repoName: HARNESS_DEFAULT_DESTINATION_REPO_NAME,
          description: HARNESS_DEFAULT_DESTINATION_DESCRIPTION,
          snapshotRoot: snapshotPreview.snapshotRoot,
          manifest: snapshotPreview.manifest,
          packageVersion: snapshotPreview.packageVersion,
          operationId: options.operationId,
          pending: activePending,
          onProgress: (progress) => {
            if (progress.phase !== lastProgressPhase) {
              phaseStartedAt = new Date().toISOString();
              lastProgressPhase = progress.phase;
            }
            void writeHarnessProvisioningProgressAtomic(
              {
                operationId: options.operationId,
                phase: progress.phase,
                phaseStartedAt,
                startedAt: progressStartedAt,
                completed: progress.completed ?? progress.uploadedBlobs,
                total: progress.total ?? progress.totalBlobs,
                rateLimitPauseSeconds: progress.rateLimitPauseSeconds,
                lastSafeCheckpoint:
                  progress.lastSafeCheckpoint ?? activePending?.phase,
              },
              options.cwd,
            ).catch(() => {
              // Progress persistence is best-effort; never fail provisioning on it.
            });
          },
          onCheckpoint: async (checkpoint) => {
            await writeHarnessProvisioningPendingStateAtomic(
              buildSnapshotPendingState({
                operationId: options.operationId,
                user,
                snapshotPreview,
                previewFingerprint: creationFingerprint,
                pending: activePending,
                phase: checkpoint.phase,
                repositoryId: checkpoint.repositoryId,
                defaultBranch: checkpoint.defaultBranch,
                initializedCommitSha: checkpoint.initializedCommitSha,
                snapshotCommitSha: checkpoint.snapshotCommitSha,
                markerCommitSha: checkpoint.markerCommitSha,
              }),
              options.cwd,
            );
            activePending = await readHarnessProvisioningPendingState(options.cwd);
            phaseStartedAt = new Date().toISOString();
            lastProgressPhase = checkpoint.phase;
            await writeHarnessProvisioningProgressAtomic(
              {
                operationId: options.operationId,
                phase: checkpoint.phase,
                phaseStartedAt,
                startedAt: progressStartedAt,
                lastSafeCheckpoint: checkpoint.phase,
              },
              options.cwd,
            );
          },
        });
        if (provisionResult.ok) {
          applyTimings.snapshotProvisioning = provisionResult.timings;
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Repository provisioning failed unexpectedly.";
        if (
          error instanceof SnapshotProvisioningError &&
          error.code === "marker-commit-failed"
        ) {
          const { owner, repo } = parseRepoSlug(destinationSlug(user.login));
          const metadata = await options.provider.getRepositoryMetadata(owner, repo);
          if (metadata) {
            const headSha = await options.provider.getRepositoryDefaultBranchHead(
              owner,
              repo,
              metadata.defaultBranch,
            );
            let initializedCommitSha = activePending?.initializedCommitSha;
            try {
              const headCommit = await options.provider.getGitCommit(owner, repo, headSha);
              initializedCommitSha =
                headCommit.parents[0]?.sha ?? initializedCommitSha;
            } catch {
              // keep best-effort pending evidence
            }
            await writeHarnessProvisioningPendingStateAtomic(
              buildSnapshotPendingState({
                operationId: options.operationId,
                user,
                snapshotPreview,
                previewFingerprint: creationFingerprint,
                pending: activePending,
                phase: "marker-pending",
                repositoryId: metadata.repositoryId,
                initializedCommitSha,
                snapshotCommitSha: headSha,
              }),
              options.cwd,
            );
          }
          return {
            state: "marker-write-pending",
            harnessDispatchRepo: destinationSlug(user.login),
            message,
            recoverable: true,
            persisted: false,
          };
        }

        const recovered = await classifyDestinationRepo(
          options.provider,
          user,
          options.cwd,
          snapshotPreview,
        );
        if (
          recovered.kind === "valid-managed" ||
          recovered.kind === "snapshot-only-with-pending"
        ) {
          return {
            state: "repo-created-pending-verification",
            harnessDispatchRepo: destinationSlug(user.login),
            message,
            recoverable: true,
            persisted: false,
          };
        } else if (error instanceof GitHubApiError && error.status === 422) {
          const retryClassification = await classifyDestinationRepo(
            options.provider,
            user,
            options.cwd,
            snapshotPreview,
          );
          if (retryClassification.kind === "absent") {
            return {
              state: "api-timeout-unknown",
              harnessDispatchRepo: destinationSlug(user.login),
              message:
                "Repository creation returned an ambiguous result. Retry Step 1 Continue.",
              recoverable: true,
              persisted: false,
            };
          }
          return {
            state: "repo-created-pending-verification",
            harnessDispatchRepo: destinationSlug(user.login),
            message,
            recoverable: true,
            persisted: false,
          };
        } else {
          return {
            state: "api-timeout-unknown",
            harnessDispatchRepo: destinationSlug(user.login),
            message,
            recoverable: true,
            persisted: false,
          };
        }
      }

      if (provisionResult) {
        if (!provisionResult.ok) {
          const markerPending =
            provisionResult.code === "marker-commit-failed" ||
            provisionResult.code === "description-finalization-failed" ||
            activePending?.phase === "marker-pending" ||
            activePending?.phase === "description-pending" ||
            Boolean(activePending?.snapshotCommitSha);
          const timedOut =
            provisionResult.code === "remote-phase-timeout" ||
            provisionResult.code === "workspace-upload-timeout";
          const phase = activePending?.phase ?? "repository-created";
          const uiPhase = mapProvisioningPhaseToUiPhase(phase);
          return {
            state: timedOut
              ? "repo-created-pending-verification"
              : markerPending
                ? "marker-write-pending"
                : provisionResult.recoverable
                  ? "repo-created-pending-verification"
                  : "api-timeout-unknown",
            harnessDispatchRepo: destinationSlug(user.login),
            message: timedOut
              ? `${provisionResult.message} Operation ID: ${options.operationId}. Retry will resume or reconcile from the last safe checkpoint.`
              : provisionResult.message,
            recoverable: provisionResult.recoverable,
            persisted: false,
            operationId: options.operationId,
            phase,
            uiPhaseLabel: uiPhaseLabel(uiPhase),
          };
        }

        targetRepo = provisionResult.fullName;
        targetRepositoryId = provisionResult.repositoryId;
        requiresSnapshotVerification = true;
        applyTimings.snapshotProvisioning = provisionResult.timings;
        await writeHarnessProvisioningPendingStateAtomic(
          buildSnapshotPendingState({
            operationId: options.operationId,
            user,
            snapshotPreview,
            previewFingerprint: creationFingerprint,
            pending: activePending,
            phase: "persistence-pending",
            repositoryId: provisionResult.repositoryId,
            defaultBranch: provisionResult.defaultBranch,
            initializedCommitSha: provisionResult.initializedCommitSha,
            snapshotCommitSha: provisionResult.snapshotCommitSha,
            markerCommitSha: provisionResult.markerCommitSha,
          }),
          options.cwd,
        );
      }
    }
  } else {
    return {
      state: preview.state,
      harnessDispatchRepo: preview.harnessDispatchRepo,
      message: preview.message,
      recoverable: preview.recoverable,
      persisted: false,
    };
  }

  if (targetRepositoryId === undefined) {
    const { owner, repo } = parseRepoSlug(targetRepo);
    const metadata = await options.provider.getRepositoryMetadata(owner, repo);
    if (!metadata) {
      return {
        state: "repo-created-pending-verification",
        harnessDispatchRepo: targetRepo,
        message: `Harness workspace ${targetRepo} is not accessible for verification.`,
        recoverable: true,
        persisted: false,
      };
    }
    targetRepositoryId = metadata.repositoryId;
  }

  if (requiresSnapshotVerification) {
    const remoteVerificationStartedAt = performance.now();
    const verification = await verifyProvisionedHarnessWorkspace({
      provider: options.provider,
      repoSlug: targetRepo,
      repositoryId: targetRepositoryId,
      manifest: snapshotPreview.manifest,
    });
    const remoteVerificationMs = elapsedHarnessProvisioningMs(
      remoteVerificationStartedAt,
    );
    applyTimings.remoteVerificationMs = remoteVerificationMs;
    if (!verification.ok) {
      return {
        state: "repo-created-pending-verification",
        harnessDispatchRepo: targetRepo,
        message: verification.message,
        recoverable: true,
        persisted: false,
        timings: applyTimings,
      };
    }
  }

  const localPersistenceStartedAt = performance.now();
  const persist = await persistGithubDispatchRepository({
    cwd: options.cwd,
    githubDispatchRepository: targetRepo,
    githubDispatchRepositoryId: targetRepositoryId,
  });
  if (persist.outcome !== "changed" && persist.outcome !== "skipped") {
    applyTimings.localPersistenceMs = elapsedHarnessProvisioningMs(
      localPersistenceStartedAt,
    );
    return {
      state: "created-but-persistence-failed",
      harnessDispatchRepo: targetRepo,
      message: persist.reason ?? "Failed to persist GITHUB_DISPATCH_REPOSITORY.",
      recoverable: true,
      persisted: false,
      timings: applyTimings,
    };
  }

  await clearHarnessProvisioningPendingState(options.cwd);
  await clearHarnessProvisioningProgress(options.cwd);
  applyTimings.localPersistenceMs = elapsedHarnessProvisioningMs(
    localPersistenceStartedAt,
  );
  await persistHarnessProvisioningLastRun({
    cwd: options.cwd,
    operationId: options.operationId,
    outcome: "success",
    timings: applyTimings,
  }).catch(() => {
    // Last-run persistence is best-effort; never fail provisioning on it.
  });
  return {
    state: "verified-and-persisted",
    harnessDispatchRepo: targetRepo,
    message: `Private harness workspace ${targetRepo} is connected.`,
    recoverable: false,
    persisted: true,
    operationId: options.operationId,
    phase: "persistence-pending",
    uiPhaseLabel: uiPhaseLabel("saving-configuration"),
    timings: applyTimings,
  };
}
