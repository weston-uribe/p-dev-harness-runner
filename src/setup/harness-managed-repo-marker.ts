import {
  HARNESS_COMPATIBILITY_VERSION,
  HARNESS_MANAGED_REPO_MARKER_FILE,
  HARNESS_MARKER_VERSION,
  HARNESS_PRODUCT,
  HARNESS_SCHEMA_VERSION,
  HARNESS_TEMPLATE_IDENTITY,
  HARNESS_TEMPLATE_SLUG,
  HARNESS_WORKSPACE_ROLE,
  type HarnessTemplateIdentity,
} from "./harness-template-identity.js";
import {
  WORKSPACE_SNAPSHOT_FORMAT_VERSION,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
  type WorkspaceSnapshotManifest,
} from "../p-dev/workspace-snapshot-types.js";
import { P_DEV_PACKAGE_NAME } from "../p-dev/package-paths.js";

export { HARNESS_MANAGED_REPO_MARKER_FILE };

export const HARNESS_LEGACY_MANAGED_REPO_MARKER_VERSION = 1;
export const HARNESS_MANAGED_REPO_MARKER_VERSION = 2;
export const HARNESS_SNAPSHOT_MANAGED_REPO_MARKER_VERSION = 3;

export interface HarnessPackageSnapshotProvenance {
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  manifestSchemaVersion: number;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  snapshotCommitSha: string;
  generationFormatVersion: number;
  defaultBranch?: string;
  fileHashes?: Record<string, string>;
}

export interface HarnessManagedRepoMarker {
  schemaVersion: number;
  product: string;
  role: string;
  managedBy: string;
  repository: string;
  repositoryId?: number;
  markerVersion: number;
  operationId?: string;
  createdByGithubUserId?: number;
  createdByLogin?: string;
  pDevVersion?: string;
  createdFromTemplate?: {
    templateRepository: string;
    defaultBranch: string;
    templateIdentity: string;
    templateVersion: number;
    compatibilityVersion: number;
    templateContentId: string;
    sourceHeadSha: string;
  };
  createdFromPackageSnapshot?: HarnessPackageSnapshotProvenance;
}

export type HarnessManagedRepoMarkerValidationResult =
  | { ok: true; marker: HarnessManagedRepoMarker }
  | { ok: false; reason: string };

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: `Managed marker is missing ${label}.` };
  }
  return { ok: true, value: value.trim() };
}

function readRequiredNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: `Managed marker is missing ${label}.` };
  }
  return { ok: true, value };
}

export function parseHarnessManagedRepoMarkerJson(
  raw: string,
): HarnessManagedRepoMarkerValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Managed marker JSON is malformed." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "Managed marker JSON is malformed." };
  }

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== HARNESS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unsupported managed marker schema version ${String(record.schemaVersion)}.`,
    };
  }
  if (record.product !== HARNESS_PRODUCT) {
    return {
      ok: false,
      reason: `Unexpected managed marker product ${String(record.product)}.`,
    };
  }
  if (record.role !== HARNESS_WORKSPACE_ROLE) {
    return {
      ok: false,
      reason: `Unexpected managed marker role ${String(record.role)}.`,
    };
  }
  if (record.managedBy !== "p-dev") {
    return {
      ok: false,
      reason: `Unexpected managedBy value ${String(record.managedBy)}.`,
    };
  }

  const repository = readRequiredString(record, "repository", "a valid repository slug");
  if (!repository.ok) {
    return { ok: false, reason: repository.reason };
  }
  if (!repository.value.includes("/")) {
    return {
      ok: false,
      reason: "Managed marker is missing a valid repository slug.",
    };
  }

  const markerVersion = readRequiredNumber(record, "markerVersion", "markerVersion");
  if (!markerVersion.ok) {
    return { ok: false, reason: markerVersion.reason };
  }
  if (
    markerVersion.value !== HARNESS_LEGACY_MANAGED_REPO_MARKER_VERSION &&
    markerVersion.value !== HARNESS_MANAGED_REPO_MARKER_VERSION &&
    markerVersion.value !== HARNESS_SNAPSHOT_MANAGED_REPO_MARKER_VERSION
  ) {
    return {
      ok: false,
      reason: `Unsupported managed marker version ${String(markerVersion.value)}.`,
    };
  }

  let repositoryId: number | undefined;
  if (
    markerVersion.value === HARNESS_MANAGED_REPO_MARKER_VERSION ||
    markerVersion.value === HARNESS_SNAPSHOT_MANAGED_REPO_MARKER_VERSION
  ) {
    const parsedRepositoryId = readRequiredNumber(
      record,
      "repositoryId",
      "repositoryId",
    );
    if (!parsedRepositoryId.ok) {
      return { ok: false, reason: parsedRepositoryId.reason };
    }
    if (
      !Number.isInteger(parsedRepositoryId.value) ||
      parsedRepositoryId.value <= 0
    ) {
      return {
        ok: false,
        reason: "Managed marker repositoryId must be a positive integer.",
      };
    }
    repositoryId = parsedRepositoryId.value;
  } else if (record.repositoryId !== undefined) {
    const parsedRepositoryId = readRequiredNumber(
      record,
      "repositoryId",
      "repositoryId",
    );
    if (!parsedRepositoryId.ok) {
      return { ok: false, reason: parsedRepositoryId.reason };
    }
    repositoryId = parsedRepositoryId.value;
  }

  const createdFromPackageSnapshot = record.createdFromPackageSnapshot;
  if (
    markerVersion.value === HARNESS_SNAPSHOT_MANAGED_REPO_MARKER_VERSION
  ) {
    if (!createdFromPackageSnapshot || typeof createdFromPackageSnapshot !== "object") {
      return {
        ok: false,
        reason: "Managed marker is missing createdFromPackageSnapshot metadata.",
      };
    }
    const snapshot = createdFromPackageSnapshot as Record<string, unknown>;
    const packageName = readRequiredString(snapshot, "packageName", "packageName");
    if (!packageName.ok) {
      return { ok: false, reason: packageName.reason };
    }
    if (packageName.value !== P_DEV_PACKAGE_NAME) {
      return {
        ok: false,
        reason: `Unexpected package name ${packageName.value}.`,
      };
    }
    const packageVersion = readRequiredString(snapshot, "packageVersion", "packageVersion");
    if (!packageVersion.ok) {
      return { ok: false, reason: packageVersion.reason };
    }
    const sourceRepository = readRequiredString(
      snapshot,
      "sourceRepository",
      "sourceRepository",
    );
    if (!sourceRepository.ok) {
      return { ok: false, reason: sourceRepository.reason };
    }
    if (sourceRepository.value !== WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY) {
      return {
        ok: false,
        reason: `Unexpected source repository ${sourceRepository.value}.`,
      };
    }
    const sourceCommit = readRequiredString(snapshot, "sourceCommit", "sourceCommit");
    if (!sourceCommit.ok) {
      return { ok: false, reason: sourceCommit.reason };
    }
    const manifestSchemaVersion = readRequiredNumber(
      snapshot,
      "manifestSchemaVersion",
      "manifestSchemaVersion",
    );
    if (!manifestSchemaVersion.ok) {
      return { ok: false, reason: manifestSchemaVersion.reason };
    }
    if (manifestSchemaVersion.value !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: `Unsupported manifest schema version ${String(manifestSchemaVersion.value)}.`,
      };
    }
    const snapshotContentId = readRequiredString(
      snapshot,
      "snapshotContentId",
      "snapshotContentId",
    );
    if (!snapshotContentId.ok) {
      return { ok: false, reason: snapshotContentId.reason };
    }
    const snapshotSha256 = readRequiredString(snapshot, "snapshotSha256", "snapshotSha256");
    if (!snapshotSha256.ok) {
      return { ok: false, reason: snapshotSha256.reason };
    }
    const snapshotGitTreeSha1 = readRequiredString(
      snapshot,
      "snapshotGitTreeSha1",
      "snapshotGitTreeSha1",
    );
    if (!snapshotGitTreeSha1.ok) {
      return { ok: false, reason: snapshotGitTreeSha1.reason };
    }
    const snapshotCommitSha = readRequiredString(
      snapshot,
      "snapshotCommitSha",
      "snapshotCommitSha",
    );
    if (!snapshotCommitSha.ok) {
      return { ok: false, reason: snapshotCommitSha.reason };
    }
    const generationFormatVersion = readRequiredNumber(
      snapshot,
      "generationFormatVersion",
      "generationFormatVersion",
    );
    if (!generationFormatVersion.ok) {
      return { ok: false, reason: generationFormatVersion.reason };
    }
    if (generationFormatVersion.value !== WORKSPACE_SNAPSHOT_FORMAT_VERSION) {
      return {
        ok: false,
        reason: `Unsupported generation format version ${String(generationFormatVersion.value)}.`,
      };
    }

    let fileHashes: Record<string, string> | undefined;
    const rawFileHashes = snapshot.fileHashes;
    if (rawFileHashes && typeof rawFileHashes === "object") {
      const parsedHashes: Record<string, string> = {};
      for (const [filePath, hash] of Object.entries(rawFileHashes)) {
        if (
          typeof filePath === "string" &&
          filePath.length > 0 &&
          typeof hash === "string" &&
          hash.length > 0
        ) {
          parsedHashes[filePath] = hash;
        }
      }
      if (Object.keys(parsedHashes).length > 0) {
        fileHashes = parsedHashes;
      }
    }

    return {
      ok: true,
      marker: {
        schemaVersion: HARNESS_SCHEMA_VERSION,
        product: HARNESS_PRODUCT,
        role: HARNESS_WORKSPACE_ROLE,
        managedBy: "p-dev",
        repository: repository.value,
        repositoryId,
        markerVersion: markerVersion.value,
        operationId:
          typeof record.operationId === "string" ? record.operationId : undefined,
        createdByGithubUserId:
          typeof record.createdByGithubUserId === "number"
            ? record.createdByGithubUserId
            : undefined,
        createdByLogin:
          typeof record.createdByLogin === "string" ? record.createdByLogin : undefined,
        pDevVersion:
          typeof record.pDevVersion === "string" ? record.pDevVersion : undefined,
        createdFromPackageSnapshot: {
          packageName: packageName.value,
          packageVersion: packageVersion.value,
          sourceRepository: sourceRepository.value,
          sourceCommit: sourceCommit.value,
          manifestSchemaVersion: manifestSchemaVersion.value,
          snapshotContentId: snapshotContentId.value,
          snapshotSha256: snapshotSha256.value,
          snapshotGitTreeSha1: snapshotGitTreeSha1.value,
          snapshotCommitSha: snapshotCommitSha.value,
          generationFormatVersion: generationFormatVersion.value,
          ...(fileHashes ? { fileHashes } : {}),
        },
      },
    };
  }

  const createdFromTemplate = record.createdFromTemplate;
  if (!createdFromTemplate || typeof createdFromTemplate !== "object") {
    return {
      ok: false,
      reason: "Managed marker is missing createdFromTemplate metadata.",
    };
  }

  const template = createdFromTemplate as Record<string, unknown>;
  const templateRepository = readRequiredString(
    template,
    "templateRepository",
    "createdFromTemplate.templateRepository",
  );
  if (!templateRepository.ok) {
    return { ok: false, reason: templateRepository.reason };
  }
  if (templateRepository.value !== HARNESS_TEMPLATE_SLUG) {
    return {
      ok: false,
      reason: `Unexpected template repository ${templateRepository.value}.`,
    };
  }
  const defaultBranch = readRequiredString(
    template,
    "defaultBranch",
    "createdFromTemplate.defaultBranch",
  );
  if (!defaultBranch.ok) {
    return { ok: false, reason: defaultBranch.reason };
  }
  const templateIdentity = readRequiredString(
    template,
    "templateIdentity",
    "createdFromTemplate.templateIdentity",
  );
  if (!templateIdentity.ok) {
    return { ok: false, reason: templateIdentity.reason };
  }
  if (templateIdentity.value !== HARNESS_TEMPLATE_IDENTITY) {
    return {
      ok: false,
      reason: `Unexpected template identity ${templateIdentity.value}.`,
    };
  }
  const templateVersion = readRequiredNumber(
    template,
    "templateVersion",
    "createdFromTemplate.templateVersion",
  );
  if (!templateVersion.ok) {
    return { ok: false, reason: templateVersion.reason };
  }
  if (templateVersion.value !== HARNESS_MARKER_VERSION) {
    return {
      ok: false,
      reason: `Unsupported template version ${String(templateVersion.value)}.`,
    };
  }
  const compatibilityVersion = readRequiredNumber(
    template,
    "compatibilityVersion",
    "createdFromTemplate.compatibilityVersion",
  );
  if (!compatibilityVersion.ok) {
    return { ok: false, reason: compatibilityVersion.reason };
  }
  if (compatibilityVersion.value !== HARNESS_COMPATIBILITY_VERSION) {
    return {
      ok: false,
      reason: `Incompatible managed marker compatibility version ${String(compatibilityVersion.value)}.`,
    };
  }
  const templateContentId = readRequiredString(
    template,
    "templateContentId",
    "createdFromTemplate.templateContentId",
  );
  if (!templateContentId.ok) {
    return { ok: false, reason: templateContentId.reason };
  }
  const sourceHeadSha = readRequiredString(
    template,
    "sourceHeadSha",
    "createdFromTemplate.sourceHeadSha",
  );
  if (!sourceHeadSha.ok) {
    return { ok: false, reason: sourceHeadSha.reason };
  }

  return {
    ok: true,
    marker: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      product: HARNESS_PRODUCT,
      role: HARNESS_WORKSPACE_ROLE,
      managedBy: "p-dev",
      repository: repository.value,
      repositoryId,
      markerVersion: markerVersion.value,
      operationId:
        typeof record.operationId === "string" ? record.operationId : undefined,
      createdByGithubUserId:
        typeof record.createdByGithubUserId === "number"
          ? record.createdByGithubUserId
          : undefined,
      createdByLogin:
        typeof record.createdByLogin === "string" ? record.createdByLogin : undefined,
      pDevVersion:
        typeof record.pDevVersion === "string" ? record.pDevVersion : undefined,
      createdFromTemplate: {
        templateRepository: templateRepository.value,
        defaultBranch: defaultBranch.value,
        templateIdentity: templateIdentity.value,
        templateVersion: templateVersion.value,
        compatibilityVersion: compatibilityVersion.value,
        templateContentId: templateContentId.value,
        sourceHeadSha: sourceHeadSha.value,
      },
    },
  };
}

export function validateManagedMarkerForReconnect(
  marker: HarnessManagedRepoMarker,
  repoSlug: string,
  metadata?: { repositoryId: number },
): { ok: true; renamedFrom?: string } | { ok: false; reason: string } {
  if (marker.markerVersion < HARNESS_MANAGED_REPO_MARKER_VERSION) {
    return {
      ok: false,
      reason:
        "Managed marker is missing a stable repository ID. Use advanced recovery to reconnect this workspace.",
    };
  }
  if (
    marker.repositoryId === undefined ||
    !Number.isInteger(marker.repositoryId) ||
    marker.repositoryId <= 0
  ) {
    return {
      ok: false,
      reason:
        "Managed marker is missing a stable repository ID. Use advanced recovery to reconnect this workspace.",
    };
  }
  if (metadata && metadata.repositoryId !== marker.repositoryId) {
    return {
      ok: false,
      reason: `Managed marker repository ID does not match GitHub metadata for ${repoSlug}.`,
    };
  }
  if (marker.repository !== repoSlug) {
    if (metadata && marker.repositoryId === metadata.repositoryId) {
      const [markerOwner] = marker.repository.split("/");
      const [slugOwner] = repoSlug.split("/");
      if (markerOwner && slugOwner && markerOwner === slugOwner) {
        return { ok: true, renamedFrom: marker.repository };
      }
    }
    return {
      ok: false,
      reason: `Managed marker repository mismatch for ${repoSlug}.`,
    };
  }
  if (marker.createdFromPackageSnapshot) {
    return { ok: true };
  }
  if (!marker.createdFromTemplate) {
    return {
      ok: false,
      reason: "Managed marker is missing workspace provenance metadata.",
    };
  }
  if (marker.createdFromTemplate.templateRepository !== HARNESS_TEMPLATE_SLUG) {
    return {
      ok: false,
      reason: `Managed marker template repository must be ${HARNESS_TEMPLATE_SLUG}.`,
    };
  }
  if (marker.createdFromTemplate.templateIdentity !== HARNESS_TEMPLATE_IDENTITY) {
    return {
      ok: false,
      reason: `Unexpected managed marker template identity ${marker.createdFromTemplate.templateIdentity}.`,
    };
  }
  if (marker.createdFromTemplate.templateVersion !== HARNESS_MARKER_VERSION) {
    return {
      ok: false,
      reason: `Unsupported managed marker template version ${marker.createdFromTemplate.templateVersion}.`,
    };
  }
  if (
    marker.createdFromTemplate.compatibilityVersion !== HARNESS_COMPATIBILITY_VERSION
  ) {
    return {
      ok: false,
      reason: `Incompatible managed marker compatibility version ${marker.createdFromTemplate.compatibilityVersion}.`,
    };
  }
  return { ok: true };
}

export function buildHarnessSnapshotManagedRepoMarker(input: {
  repository: string;
  repositoryId: number;
  manifest: WorkspaceSnapshotManifest;
  snapshotCommitSha: string;
  defaultBranch: string;
  operationId?: string;
  createdByGithubUserId?: number;
  createdByLogin?: string;
  pDevVersion?: string;
}): HarnessManagedRepoMarker {
  if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw new Error("Managed marker requires a positive integer repositoryId.");
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    product: HARNESS_PRODUCT,
    role: HARNESS_WORKSPACE_ROLE,
    managedBy: "p-dev",
    repository: input.repository,
    repositoryId: input.repositoryId,
    markerVersion: HARNESS_SNAPSHOT_MANAGED_REPO_MARKER_VERSION,
    operationId: input.operationId,
    createdByGithubUserId: input.createdByGithubUserId,
    createdByLogin: input.createdByLogin,
    pDevVersion: input.pDevVersion,
    createdFromPackageSnapshot: {
      packageName: input.manifest.packageName,
      packageVersion: input.manifest.packageVersion,
      sourceRepository: input.manifest.sourceRepository,
      sourceCommit: input.manifest.sourceCommit,
      manifestSchemaVersion: input.manifest.schemaVersion,
      snapshotContentId: input.manifest.snapshotContentId,
      snapshotSha256: input.manifest.snapshotSha256,
      snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
      snapshotCommitSha: input.snapshotCommitSha,
      generationFormatVersion: input.manifest.generation.version,
      defaultBranch: input.defaultBranch,
      fileHashes: Object.fromEntries(
        input.manifest.files.map((file) => [file.path, file.sha256]),
      ),
    },
  };
}

export function buildHarnessManagedRepoMarker(input: {
  repository: string;
  repositoryId: number;
  templateIdentity: HarnessTemplateIdentity;
  defaultBranch: string;
  sourceHeadSha: string;
  operationId?: string;
  createdByGithubUserId?: number;
  createdByLogin?: string;
  pDevVersion?: string;
}): HarnessManagedRepoMarker {
  if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw new Error("Managed marker requires a positive integer repositoryId.");
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    product: HARNESS_PRODUCT,
    role: HARNESS_WORKSPACE_ROLE,
    managedBy: "p-dev",
    repository: input.repository,
    repositoryId: input.repositoryId,
    markerVersion: HARNESS_MANAGED_REPO_MARKER_VERSION,
    operationId: input.operationId,
    createdByGithubUserId: input.createdByGithubUserId,
    createdByLogin: input.createdByLogin,
    pDevVersion: input.pDevVersion,
    createdFromTemplate: {
      templateRepository: HARNESS_TEMPLATE_SLUG,
      defaultBranch: input.defaultBranch,
      templateIdentity: input.templateIdentity.templateIdentity,
      templateVersion: input.templateIdentity.templateVersion,
      compatibilityVersion: input.templateIdentity.compatibilityVersion,
      templateContentId: input.templateIdentity.templateContentId,
      sourceHeadSha: input.sourceHeadSha,
    },
  };
}

export function markersAreEquivalentForOperation(
  existing: HarnessManagedRepoMarker,
  expected: HarnessManagedRepoMarker,
): boolean {
  if (existing.createdFromPackageSnapshot && expected.createdFromPackageSnapshot) {
    return (
      existing.repository === expected.repository &&
      existing.repositoryId === expected.repositoryId &&
      existing.operationId === expected.operationId &&
      existing.createdFromPackageSnapshot.snapshotContentId ===
        expected.createdFromPackageSnapshot.snapshotContentId &&
      existing.createdFromPackageSnapshot.snapshotSha256 ===
        expected.createdFromPackageSnapshot.snapshotSha256 &&
      existing.createdFromPackageSnapshot.snapshotCommitSha ===
        expected.createdFromPackageSnapshot.snapshotCommitSha
    );
  }
  if (!existing.createdFromTemplate || !expected.createdFromTemplate) {
    return false;
  }
  return (
    existing.repository === expected.repository &&
    existing.repositoryId === expected.repositoryId &&
    existing.operationId === expected.operationId &&
    existing.createdFromTemplate.templateIdentity ===
      expected.createdFromTemplate.templateIdentity &&
    existing.createdFromTemplate.compatibilityVersion ===
      expected.createdFromTemplate.compatibilityVersion &&
    existing.createdFromTemplate.templateContentId ===
      expected.createdFromTemplate.templateContentId &&
    existing.createdFromTemplate.sourceHeadSha ===
      expected.createdFromTemplate.sourceHeadSha
  );
}

export function markerValidForExistingWorkspace(
  existing: HarnessManagedRepoMarker,
  repoSlug: string,
  metadata?: { repositoryId: number },
): boolean {
  return validateManagedMarkerForReconnect(existing, repoSlug, metadata).ok;
}
