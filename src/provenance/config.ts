/**
 * Runner startup / config validation for provenance (not Cursor CSV preflight).
 */

import {
  resolveProvenanceMode,
  type ProvenanceWriterMode,
} from "./mode.js";
import { PROVENANCE_KEY_ENV, parseProvenanceKey } from "./encryption.js";
import {
  launchSurfacesManifestDigest,
  PROVENANCE_WRITER_VERSION,
} from "./launch-surfaces.js";
import {
  P_DEV_STATE_GITHUB_TOKEN_ENV,
  P_DEV_WORKFLOW_STATE_BRANCH_ENV,
  P_DEV_WORKFLOW_STATE_REPOSITORY_ENV,
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../public-execution/runtime-repos.js";

export interface ProvenanceConfigHealth {
  mode: ProvenanceWriterMode;
  healthy: boolean;
  /** Only required mode treats unhealthy as a mutation gate. */
  blocksProviderMutation: boolean;
  writerVersion: string;
  launchSurfacesManifestDigest: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export function validateProvenanceConfig(
  env: Record<string, string | undefined> = process.env,
): ProvenanceConfigHealth {
  let mode: ProvenanceWriterMode = "disabled";
  const checks: ProvenanceConfigHealth["checks"] = [];

  try {
    mode = resolveProvenanceMode(env);
    checks.push({
      name: "mode",
      ok: true,
      detail: mode,
    });
  } catch (error) {
    checks.push({
      name: "mode",
      ok: false,
      detail: error instanceof Error ? error.message : "invalid mode",
    });
  }

  if (mode === "disabled") {
    return {
      mode,
      healthy: true,
      blocksProviderMutation: false,
      writerVersion: PROVENANCE_WRITER_VERSION,
      launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
      checks: [
        ...checks,
        {
          name: "credentials",
          ok: true,
          detail: "not required in disabled mode",
        },
      ],
    };
  }

  try {
    parseProvenanceKey(env[PROVENANCE_KEY_ENV]);
    checks.push({ name: "encryption_key", ok: true, detail: "present" });
  } catch {
    checks.push({
      name: "encryption_key",
      ok: false,
      detail: `${PROVENANCE_KEY_ENV} missing or invalid`,
    });
  }

  const repo = resolveWorkflowStateRepository(env);
  checks.push({
    name: "state_repository",
    ok: Boolean(repo),
    detail: repo
      ? `${repo.owner}/${repo.repo}`
      : `${P_DEV_WORKFLOW_STATE_REPOSITORY_ENV} missing`,
  });

  const branch = resolveWorkflowStateBranch(env);
  checks.push({
    name: "state_branch",
    ok: Boolean(branch),
    detail: branch || `${P_DEV_WORKFLOW_STATE_BRANCH_ENV} missing`,
  });

  const token = resolveStateGithubToken(env);
  checks.push({
    name: "state_token",
    ok: Boolean(token),
    detail: token
      ? "present"
      : `${P_DEV_STATE_GITHUB_TOKEN_ENV} (or fallback) missing`,
  });

  checks.push({
    name: "writer_version",
    ok: true,
    detail: PROVENANCE_WRITER_VERSION,
  });
  checks.push({
    name: "launch_surfaces_manifest_digest",
    ok: true,
    detail: launchSurfacesManifestDigest(),
  });

  const healthy = checks.every((c) => c.ok);
  return {
    mode,
    healthy,
    blocksProviderMutation: mode === "required" && !healthy,
    writerVersion: PROVENANCE_WRITER_VERSION,
    launchSurfacesManifestDigest: launchSurfacesManifestDigest(),
    checks,
  };
}
