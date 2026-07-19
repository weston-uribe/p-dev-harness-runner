import { createHash, randomUUID } from "node:crypto";
import {
  PRODUCT_MARKER_PATH,
  PRODUCT_README_PATH,
  TARGET_REPO_DEV_BRANCH,
  TARGET_REPO_MAIN_BRANCH,
  buildProductReadme,
  buildUninitializedProductMarker,
  hashProductMarkerContent,
  serializeProductMarker,
} from "../product/product-marker.js";
import type { GitHubTargetRepositoryProvider } from "./github-target-repository-provider.js";
import {
  validateGitHubRepositoryName,
  validateRepositoryOwnerMatchesActor,
} from "./github-repository-name.js";
import {
  readTargetRepoProvisioningPendingState,
  validateTargetRepoPendingResume,
  withTargetRepoProvisioningMutex,
  writeTargetRepoProvisioningPendingStateAtomic,
  type TargetRepoProvisioningPendingState,
} from "./target-repo-provisioning-pending-state.js";

export type TargetRepoProvisioningVisibility = "private" | "public";

export interface TargetRepoProvisioningRequest {
  owner: string;
  name: string;
  description?: string;
  visibility?: TargetRepoProvisioningVisibility;
  operationId?: string;
  creationActionId?: string;
  createdAt?: string;
}

export interface TargetRepoProvisioningPreview {
  state: "preview-ready" | "repository_already_exists" | "invalid-input" | "preview-stale";
  fingerprint: string;
  operationId: string;
  creationActionId: string;
  createdAt: string;
  owner: string;
  repositoryName: string;
  repositoryFullName: string;
  visibility: TargetRepoProvisioningVisibility;
  description: string;
  initialBranches: string[];
  initialFilePaths: string[];
  resultingTargetRepoConfigId: string;
  actionsWillPerform: string[];
  actionsWillNotPerform: string[];
  message: string;
  connectExistingHint?: string;
  resumedFromPending: boolean;
}

export interface TargetRepoProvisioningApplyInput {
  owner: string;
  name: string;
  description?: string;
  visibility?: TargetRepoProvisioningVisibility;
  operationId: string;
  creationActionId: string;
  createdAt: string;
  fingerprint: string;
  confirmed: boolean;
}

export interface TargetRepoProvisioningApplyResult {
  state:
    | "verified-complete"
    | "setup-incomplete"
    | "repository_already_exists"
    | "preview-stale"
    | "owner-mismatch"
    | "invalid-input";
  operationId: string;
  creationActionId: string;
  repositoryUrl: string | null;
  repositoryFullName: string | null;
  repositoryId: number | null;
  mainSha: string | null;
  devSha: string | null;
  defaultBranchCorrected: boolean;
  initialFilePaths: string[];
  message: string;
  connectExistingHint?: string;
}

function hashFingerprintInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function normalizeRequest(input: TargetRepoProvisioningRequest): {
  owner: string;
  name: string;
  description: string;
  visibility: TargetRepoProvisioningVisibility;
} {
  return {
    owner: input.owner.trim(),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    visibility: input.visibility ?? "private",
  };
}

function buildFingerprintInput(input: {
  owner: string;
  name: string;
  description: string;
  visibility: TargetRepoProvisioningVisibility;
  operationId: string;
  creationActionId: string;
  createdAt: string;
}): string {
  return hashFingerprintInput({
    action: "target-repo-provisioning",
    owner: input.owner,
    name: input.name,
    description: input.description,
    visibility: input.visibility,
    operationId: input.operationId,
    creationActionId: input.creationActionId,
    createdAt: input.createdAt,
    mainBranch: TARGET_REPO_MAIN_BRANCH,
    devBranch: TARGET_REPO_DEV_BRANCH,
    initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
  });
}

function buildBootstrapFiles(input: {
  productName: string;
  createdAt: string;
  operationId: string;
  creationActionId: string;
}): Array<{ path: string; content: string }> {
  const marker = buildUninitializedProductMarker({
    createdAt: input.createdAt,
    operationId: input.operationId,
    creationActionId: input.creationActionId,
  });
  return [
    {
      path: PRODUCT_README_PATH,
      content: buildProductReadme(input.productName),
    },
    {
      path: PRODUCT_MARKER_PATH,
      content: serializeProductMarker(marker),
    },
  ];
}

async function ensureMainBranchReady(
  provider: GitHubTargetRepositoryProvider,
  owner: string,
  repo: string,
): Promise<{ mainSha: string; defaultBranchCorrected: boolean }> {
  let mainExists = await provider.verifyBranchExists(owner, repo, TARGET_REPO_MAIN_BRANCH);
  if (!mainExists) {
    const metadata = await provider.getRepositoryMetadata(owner, repo);
    const existingDefault = metadata?.defaultBranch;
    if (existingDefault && existingDefault !== TARGET_REPO_MAIN_BRANCH) {
      const existingHead = await provider.getRepositoryDefaultBranchHead(
        owner,
        repo,
        existingDefault,
      );
      await provider.createGitRef(
        owner,
        repo,
        TARGET_REPO_MAIN_BRANCH,
        existingHead,
      );
      mainExists = true;
    }
  }
  if (!mainExists) {
    throw new Error(
      `Repository ${owner}/${repo} is missing required branch ${TARGET_REPO_MAIN_BRANCH}.`,
    );
  }
  const defaultBranch = await provider.ensureDefaultBranch(
    owner,
    repo,
    TARGET_REPO_MAIN_BRANCH,
  );
  const mainSha = await provider.getRepositoryDefaultBranchHead(
    owner,
    repo,
    TARGET_REPO_MAIN_BRANCH,
  );
  return { mainSha, defaultBranchCorrected: defaultBranch.corrected };
}

async function verifyBootstrapFiles(
  provider: GitHubTargetRepositoryProvider,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  for (const filePath of [PRODUCT_README_PATH, PRODUCT_MARKER_PATH]) {
    const content = await provider.readRepositoryFileContent(owner, repo, filePath, branch);
    if (!content) {
      throw new Error(`Missing ${filePath} on branch ${branch}.`);
    }
  }
}

export async function previewTargetRepoProvisioning(input: {
  request: TargetRepoProvisioningRequest;
  provider: GitHubTargetRepositoryProvider;
  cwd?: string;
}): Promise<TargetRepoProvisioningPreview> {
  const normalized = normalizeRequest(input.request);
  const nameValidation = validateGitHubRepositoryName(normalized.name);
  if (!nameValidation.ok) {
    return {
      state: "invalid-input",
      fingerprint: "",
      operationId: input.request.operationId ?? "",
      creationActionId: input.request.creationActionId ?? "",
      createdAt: input.request.createdAt ?? "",
      owner: normalized.owner,
      repositoryName: normalized.name,
      repositoryFullName: `${normalized.owner}/${normalized.name}`,
      visibility: normalized.visibility,
      description: normalized.description,
      initialBranches: [TARGET_REPO_MAIN_BRANCH, TARGET_REPO_DEV_BRANCH],
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      resultingTargetRepoConfigId: `target-${normalized.name}`,
      actionsWillPerform: [],
      actionsWillNotPerform: [],
      message: nameValidation.reason,
      resumedFromPending: false,
    };
  }

  const user = await input.provider.resolveAuthenticatedUser();
  const ownerValidation = validateRepositoryOwnerMatchesActor(
    normalized.owner,
    user.login,
  );
  if (!ownerValidation.ok) {
    return {
      state: "invalid-input",
      fingerprint: "",
      operationId: input.request.operationId ?? "",
      creationActionId: input.request.creationActionId ?? "",
      createdAt: input.request.createdAt ?? "",
      owner: normalized.owner,
      repositoryName: nameValidation.normalized,
      repositoryFullName: `${normalized.owner}/${nameValidation.normalized}`,
      visibility: normalized.visibility,
      description: normalized.description,
      initialBranches: [TARGET_REPO_MAIN_BRANCH, TARGET_REPO_DEV_BRANCH],
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      resultingTargetRepoConfigId: `target-${nameValidation.normalized}`,
      actionsWillPerform: [],
      actionsWillNotPerform: [],
      message: ownerValidation.reason,
      resumedFromPending: false,
    };
  }

  const repositoryFullName = `${normalized.owner}/${nameValidation.normalized}`;
  const availability = await input.provider.checkRepositoryAvailability(
    normalized.owner,
    nameValidation.normalized,
  );
  if (availability === "repository_already_exists") {
    return {
      state: "repository_already_exists",
      fingerprint: "",
      operationId: input.request.operationId ?? "",
      creationActionId: input.request.creationActionId ?? "",
      createdAt: input.request.createdAt ?? "",
      owner: normalized.owner,
      repositoryName: nameValidation.normalized,
      repositoryFullName,
      visibility: normalized.visibility,
      description: normalized.description,
      initialBranches: [TARGET_REPO_MAIN_BRANCH, TARGET_REPO_DEV_BRANCH],
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      resultingTargetRepoConfigId: `target-${nameValidation.normalized}`,
      actionsWillPerform: [],
      actionsWillNotPerform: [
        "Overwrite or repurpose an existing repository",
        "Select an application stack or framework",
        "Configure application deployment",
      ],
      message: "A repository with this name already exists.",
      connectExistingHint: `https://github.com/${repositoryFullName}`,
      resumedFromPending: false,
    };
  }

  let operationId = input.request.operationId;
  let creationActionId = input.request.creationActionId;
  let createdAt = input.request.createdAt;
  let resumedFromPending = false;

  if (operationId) {
    const pending = await readTargetRepoProvisioningPendingState(operationId, input.cwd);
    if (pending) {
      creationActionId = pending.creationActionId;
      createdAt = pending.createdAt;
      resumedFromPending = true;
    }
  }

  operationId = operationId ?? randomUUID();
  creationActionId = creationActionId ?? randomUUID();
  createdAt = createdAt ?? new Date().toISOString();

  const fingerprint = buildFingerprintInput({
    owner: normalized.owner,
    name: nameValidation.normalized,
    description: normalized.description,
    visibility: normalized.visibility,
    operationId,
    creationActionId,
    createdAt,
  });

  const actionsWillPerform = [
    `Create private repository ${repositoryFullName}`.replace(
      "private",
      normalized.visibility,
    ),
    `Ensure ${TARGET_REPO_MAIN_BRANCH} exists and is the GitHub default branch`,
    `Add ${PRODUCT_README_PATH} and ${PRODUCT_MARKER_PATH} in one commit on ${TARGET_REPO_MAIN_BRANCH}`,
    `Create ${TARGET_REPO_DEV_BRANCH} from the final ${TARGET_REPO_MAIN_BRANCH} head`,
  ];
  const actionsWillNotPerform = [
    "Select an application stack or framework",
    "Add package manifests, source directories, or stack-specific CI",
    "Configure application deployment or Vercel application hosting",
    "Install the generic PDev target workflow (handled in setup Step 7)",
  ];

  return {
    state: "preview-ready",
    fingerprint,
    operationId,
    creationActionId,
    createdAt,
    owner: normalized.owner,
    repositoryName: nameValidation.normalized,
    repositoryFullName,
    visibility: normalized.visibility,
    description: normalized.description,
    initialBranches: [TARGET_REPO_MAIN_BRANCH, TARGET_REPO_DEV_BRANCH],
    initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
    resultingTargetRepoConfigId: `target-${nameValidation.normalized}`,
    actionsWillPerform,
    actionsWillNotPerform,
    message: resumedFromPending
      ? "Resume target repository provisioning from saved operation state."
      : "Ready to create a technology-neutral product repository.",
    resumedFromPending,
  };
}

export async function applyTargetRepoProvisioning(input: {
  apply: TargetRepoProvisioningApplyInput;
  provider: GitHubTargetRepositoryProvider;
  cwd?: string;
}): Promise<TargetRepoProvisioningApplyResult> {
  if (!input.apply.confirmed) {
    return {
      state: "invalid-input",
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
      repositoryUrl: null,
      repositoryFullName: null,
      repositoryId: null,
      mainSha: null,
      devSha: null,
      defaultBranchCorrected: false,
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      message: "Explicit confirmation is required before applying repository creation.",
    };
  }

  const normalized = normalizeRequest(input.apply);
  const nameValidation = validateGitHubRepositoryName(normalized.name);
  if (!nameValidation.ok) {
    return {
      state: "invalid-input",
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
      repositoryUrl: null,
      repositoryFullName: null,
      repositoryId: null,
      mainSha: null,
      devSha: null,
      defaultBranchCorrected: false,
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      message: nameValidation.reason,
    };
  }

  const repositoryFullName = `${normalized.owner}/${nameValidation.normalized}`;
  const expectedFingerprint = buildFingerprintInput({
    owner: normalized.owner,
    name: nameValidation.normalized,
    description: normalized.description,
    visibility: normalized.visibility,
    operationId: input.apply.operationId,
    creationActionId: input.apply.creationActionId,
    createdAt: input.apply.createdAt,
  });

  if (expectedFingerprint !== input.apply.fingerprint) {
    return {
      state: "preview-stale",
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
      repositoryUrl: null,
      repositoryFullName,
      repositoryId: null,
      mainSha: null,
      devSha: null,
      defaultBranchCorrected: false,
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      message: "Target repository provisioning preview is stale.",
    };
  }

  const user = await input.provider.resolveAuthenticatedUser();
  const ownerValidation = validateRepositoryOwnerMatchesActor(
    normalized.owner,
    user.login,
  );
  if (!ownerValidation.ok) {
    return {
      state: "owner-mismatch",
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
      repositoryUrl: null,
      repositoryFullName,
      repositoryId: null,
      mainSha: null,
      devSha: null,
      defaultBranchCorrected: false,
      initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
      message: ownerValidation.reason,
    };
  }

  return withTargetRepoProvisioningMutex(input.cwd ?? process.cwd(), async () => {
    const existingPending = await readTargetRepoProvisioningPendingState(
      input.apply.operationId,
      input.cwd,
    );
    if (existingPending) {
      const resumeValidation = validateTargetRepoPendingResume(existingPending, {
        operationId: input.apply.operationId,
        creationActionId: input.apply.creationActionId,
        owner: normalized.owner,
        repositoryFullName,
        previewFingerprint: input.apply.fingerprint,
      });
      if (!resumeValidation.ok) {
        return {
          state: "preview-stale",
          operationId: input.apply.operationId,
          creationActionId: input.apply.creationActionId,
          repositoryUrl: null,
          repositoryFullName,
          repositoryId: null,
          mainSha: null,
          devSha: null,
          defaultBranchCorrected: false,
          initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
          message: resumeValidation.reason,
        };
      }
    } else {
      const availability = await input.provider.checkRepositoryAvailability(
        normalized.owner,
        nameValidation.normalized,
      );
      if (availability === "repository_already_exists") {
        return {
          state: "repository_already_exists",
          operationId: input.apply.operationId,
          creationActionId: input.apply.creationActionId,
          repositoryUrl: `https://github.com/${repositoryFullName}`,
          repositoryFullName,
          repositoryId: null,
          mainSha: null,
          devSha: null,
          defaultBranchCorrected: false,
          initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
          message: "A repository with this name already exists.",
          connectExistingHint: `https://github.com/${repositoryFullName}`,
        };
      }
    }

    const markerFiles = buildBootstrapFiles({
      productName: nameValidation.normalized,
      createdAt: input.apply.createdAt,
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
    });
    const markerContent = markerFiles.find((file) => file.path === PRODUCT_MARKER_PATH)
      ?.content;
    const markerContentHash = markerContent
      ? hashProductMarkerContent(markerContent)
      : undefined;

    let pending: TargetRepoProvisioningPendingState = existingPending ?? {
      operationId: input.apply.operationId,
      creationActionId: input.apply.creationActionId,
      createdAt: input.apply.createdAt,
      authenticatedUserId: user.id,
      authenticatedLogin: user.login,
      targetOwner: normalized.owner,
      targetRepo: nameValidation.normalized,
      repositoryFullName,
      visibility: normalized.visibility,
      description: normalized.description,
      previewFingerprint: input.apply.fingerprint,
      startedAt: input.apply.createdAt,
      phase: "pending-preview",
      completionState: "incomplete",
      markerPath: PRODUCT_MARKER_PATH,
      markerContentHash,
    };

    if (!existingPending) {
      await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);
    }

    try {
      let repositoryId = pending.repositoryId;
      let mainSha = pending.mainSha;
      let devSha = pending.devSha;
      let defaultBranchCorrected = pending.defaultBranchCorrected ?? false;

      if (!repositoryId) {
        const created = await input.provider.createPersonalRepository({
          owner: normalized.owner,
          name: nameValidation.normalized,
          description: normalized.description,
          visibility: normalized.visibility,
        });
        repositoryId = created.repositoryId;
        pending = {
          ...pending,
          repositoryId,
          phase: "repository-created",
        };
        await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);
      }

      if (!mainSha || pending.phase === "repository-created") {
        const mainReady = await ensureMainBranchReady(
          input.provider,
          normalized.owner,
          nameValidation.normalized,
        );
        mainSha = mainReady.mainSha;
        defaultBranchCorrected = mainReady.defaultBranchCorrected;
        pending = {
          ...pending,
          mainSha,
          defaultBranchCorrected,
          phase: defaultBranchCorrected ? "default-branch-corrected" : "main-verified",
        };
        await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);
      }

      const metadata = await input.provider.getRepositoryMetadata(
        normalized.owner,
        nameValidation.normalized,
      );
      const currentMainSha = await input.provider.getRepositoryDefaultBranchHead(
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_MAIN_BRANCH,
      );
      const markerOnMain = await input.provider.readRepositoryFileContent(
        normalized.owner,
        nameValidation.normalized,
        PRODUCT_MARKER_PATH,
        TARGET_REPO_MAIN_BRANCH,
      );

      if (!markerOnMain) {
        const bootstrapParentSha = currentMainSha;
        const bootstrap = await input.provider.writeBootstrapCommit({
          owner: normalized.owner,
          repo: nameValidation.normalized,
          branch: TARGET_REPO_MAIN_BRANCH,
          parentSha: bootstrapParentSha,
          files: markerFiles,
          message: "Initialize PDev product repository",
        });
        mainSha = bootstrap.commitSha;
        pending = {
          ...pending,
          mainSha,
          markerContentHash,
          phase: "bootstrap-committed",
        };
        await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);
      } else {
        mainSha = currentMainSha;
      }

      const finalMainSha = await input.provider.getRepositoryDefaultBranchHead(
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_MAIN_BRANCH,
      );
      mainSha = finalMainSha;

      const devExists = await input.provider.verifyBranchExists(
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_DEV_BRANCH,
      );
      if (!devExists) {
        await input.provider.createGitRef(
          normalized.owner,
          nameValidation.normalized,
          TARGET_REPO_DEV_BRANCH,
          finalMainSha,
        );
      }
      devSha = await input.provider.getRepositoryDefaultBranchHead(
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_DEV_BRANCH,
      );

      await verifyBootstrapFiles(
        input.provider,
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_MAIN_BRANCH,
      );
      await verifyBootstrapFiles(
        input.provider,
        normalized.owner,
        nameValidation.normalized,
        TARGET_REPO_DEV_BRANCH,
      );

      pending = {
        ...pending,
        mainSha,
        devSha,
        repositoryId: repositoryId ?? metadata?.repositoryId,
        phase: "verified-complete",
        completionState: "complete",
      };
      await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);

      return {
        state: "verified-complete",
        operationId: input.apply.operationId,
        creationActionId: input.apply.creationActionId,
        repositoryUrl: `https://github.com/${repositoryFullName}`,
        repositoryFullName,
        repositoryId: pending.repositoryId ?? null,
        mainSha,
        devSha,
        defaultBranchCorrected,
        initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
        message: defaultBranchCorrected
          ? "Repository created; GitHub default branch was corrected to main."
          : "Repository created and verified.",
      };
    } catch (error) {
      pending = {
        ...pending,
        completionState: "setup-incomplete",
      };
      await writeTargetRepoProvisioningPendingStateAtomic(pending, input.cwd);
      const message =
        error instanceof Error ? error.message : "Repository setup incomplete.";
      return {
        state: "setup-incomplete",
        operationId: input.apply.operationId,
        creationActionId: input.apply.creationActionId,
        repositoryUrl: `https://github.com/${repositoryFullName}`,
        repositoryFullName,
        repositoryId: pending.repositoryId ?? null,
        mainSha: pending.mainSha ?? null,
        devSha: pending.devSha ?? null,
        defaultBranchCorrected: pending.defaultBranchCorrected ?? false,
        initialFilePaths: [PRODUCT_README_PATH, PRODUCT_MARKER_PATH],
        message: `Repository created; setup incomplete. ${message}`,
      };
    }
  });
}
