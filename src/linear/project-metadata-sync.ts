import type { LinearClient } from "@linear/sdk";
import {
  upsertHarnessMetadataInDescription,
  type HarnessProjectMetadata,
} from "../linear/project-harness-metadata.js";
import { readProductMarker } from "../product/read-product-marker.js";
import {
  resolveProductInitializationState,
  type ResolvedProductInitialization,
} from "../product/initialization-state.js";
import { parseHarnessMarkers } from "../linear/markers.js";
import type { GitHubClient } from "../github/client.js";

export const PROJECT_METADATA_SYNC_PHASE = "project_metadata_initialized_sync";

export interface SyncProjectHarnessMetadataInput {
  linearClient: LinearClient;
  projectId: string;
  currentDescription: string | null | undefined;
  targetRepo: string;
  developmentBranch: string;
  github: GitHubClient;
  orchestratorMarker: string;
  mergeRunId: string;
  comments: { body: string }[];
}

export interface SyncProjectHarnessMetadataResult {
  updated: boolean;
  skippedReason?: string;
  productInitialization?: ResolvedProductInitialization;
  description?: string;
}

function hasProjectMetadataSyncMarker(
  comments: { body: string }[],
  orchestratorMarker: string,
  mergeRunId: string,
): boolean {
  return comments.some((comment) => {
    const markers = parseHarnessMarkers(comment.body);
    return (
      markers.orchestratorMarker === orchestratorMarker &&
      markers.phase === PROJECT_METADATA_SYNC_PHASE &&
      markers.runId === mergeRunId
    );
  });
}

export async function syncProjectHarnessMetadataAfterFoundationMerge(
  input: SyncProjectHarnessMetadataInput,
): Promise<SyncProjectHarnessMetadataResult> {
  const markerRead = await readProductMarker({
    targetRepo: input.targetRepo,
    developmentBranch: input.developmentBranch,
    github: input.github,
  });
  const productInitialization = resolveProductInitializationState(markerRead.content);
  if (productInitialization.state !== "initialized") {
    return {
      updated: false,
      skippedReason: "product_not_initialized",
      productInitialization,
    };
  }

  const current = input.currentDescription ?? "";
  const nextDescription = upsertHarnessMetadataInDescription(current, {
    targetRepo: input.targetRepo.replace(/^https:\/\/github\.com\//, ""),
    productInitialization: "initialized",
  });

  if (nextDescription === current) {
    return {
      updated: false,
      skippedReason: "metadata_already_initialized",
      productInitialization,
      description: current,
    };
  }

  if (
    hasProjectMetadataSyncMarker(
      input.comments,
      input.orchestratorMarker,
      input.mergeRunId,
    )
  ) {
    return {
      updated: false,
      skippedReason: "duplicate_sync_marker",
      productInitialization,
      description: current,
    };
  }

  await input.linearClient.updateProject(input.projectId, {
    description: nextDescription,
  });

  return {
    updated: true,
    productInitialization,
    description: nextDescription,
  };
}

export function buildHarnessMetadataForNewProduct(input: {
  targetRepo: string;
}): HarnessProjectMetadata {
  return {
    targetRepo: input.targetRepo.replace(/^https:\/\/github\.com\//, ""),
    productInitialization: "uninitialized",
  };
}
