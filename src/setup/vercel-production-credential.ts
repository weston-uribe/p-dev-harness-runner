import { listVercelTeams } from "./vercel-setup-client.js";
import {
  configRequiresVercelProductionDeploymentVerification,
  listReposRequiringVercelProductionDeploymentVerification,
  type ProductionSyncRepoLike,
} from "../preview/production-verification-requirement.js";

/**
 * Sanitized Vercel production-credential classifications.
 * Never include token values in these results.
 */
export type VercelProductionCredentialClassification =
  | "not_required"
  | "secret_name_absent"
  | "secret_injected_but_empty"
  | "provider_authentication_rejected"
  | "provider_api_temporarily_unavailable"
  | "configured_repository_project_not_accessible"
  | "successful_read_only_authentication";

export interface VercelProductionCredentialCheck {
  checkName: "vercel_production_deployment_credential";
  required: boolean;
  ok: boolean;
  severity: "critical" | "informational";
  classification: VercelProductionCredentialClassification;
  missingEnvironmentVariable?: "VERCEL_TOKEN";
  productionProjectionBlocked: boolean;
  affectedRepoIds: string[];
  provider: "vercel";
  detail: string;
}

export function classifyVercelProductionCredential(input: {
  repos: ProductionSyncRepoLike[];
  /** Whether the Actions secret name is configured on the runner (when known). */
  secretNamePresent?: boolean | null;
  env?: NodeJS.ProcessEnv;
}): VercelProductionCredentialCheck {
  const affected = listReposRequiringVercelProductionDeploymentVerification({
    repos: input.repos,
  });
  const required = affected.length > 0;
  const base = {
    checkName: "vercel_production_deployment_credential" as const,
    provider: "vercel" as const,
    affectedRepoIds: affected
      .map((repo) => repo.id)
      .filter((id): id is string => Boolean(id)),
  };

  if (!required) {
    return {
      ...base,
      required: false,
      ok: true,
      severity: "informational",
      classification: "not_required",
      productionProjectionBlocked: false,
      detail: "No configured repo requires Vercel production deployment verification.",
    };
  }

  if (input.secretNamePresent === false) {
    return {
      ...base,
      required: true,
      ok: false,
      severity: "critical",
      classification: "secret_name_absent",
      missingEnvironmentVariable: "VERCEL_TOKEN",
      productionProjectionBlocked: true,
      detail:
        "VERCEL_TOKEN Actions secret is not configured on the managed runner.",
    };
  }

  const token = (input.env ?? process.env).VERCEL_TOKEN;
  if (token === undefined || token === null) {
    return {
      ...base,
      required: true,
      ok: false,
      severity: "critical",
      classification: "secret_name_absent",
      missingEnvironmentVariable: "VERCEL_TOKEN",
      productionProjectionBlocked: true,
      detail: "VERCEL_TOKEN is missing from the runtime environment.",
    };
  }
  if (!String(token).trim()) {
    return {
      ...base,
      required: true,
      ok: false,
      severity: "critical",
      classification: "secret_injected_but_empty",
      missingEnvironmentVariable: "VERCEL_TOKEN",
      productionProjectionBlocked: true,
      detail: "VERCEL_TOKEN is present but empty.",
    };
  }

  return {
    ...base,
    required: true,
    ok: true,
    severity: "informational",
    classification: "successful_read_only_authentication",
    productionProjectionBlocked: false,
    detail:
      "VERCEL_TOKEN is present. Call verifyVercelProductionCredentialAuth for live auth classification.",
  };
}

export async function verifyVercelProductionCredentialAuth(input: {
  repos: ProductionSyncRepoLike[];
  vercelToken: string;
  secretNamePresent?: boolean | null;
}): Promise<VercelProductionCredentialCheck> {
  const presence = classifyVercelProductionCredential({
    repos: input.repos,
    secretNamePresent: input.secretNamePresent,
    env: { VERCEL_TOKEN: input.vercelToken },
  });
  if (!presence.required || !presence.ok) {
    return presence;
  }

  try {
    const teams = await listVercelTeams(input.vercelToken.trim());
    if (!Array.isArray(teams)) {
      return {
        ...presence,
        ok: false,
        severity: "critical",
        classification: "provider_authentication_rejected",
        productionProjectionBlocked: true,
        detail: "Vercel API returned an unexpected teams payload.",
      };
    }
    return {
      ...presence,
      ok: true,
      severity: "informational",
      classification: "successful_read_only_authentication",
      productionProjectionBlocked: false,
      detail: `Vercel read-only authentication succeeded (${teams.length} team(s) visible).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/\b([45]\d\d)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;

    if (status === 401 || status === 403) {
      return {
        ...presence,
        ok: false,
        severity: "critical",
        classification: "provider_authentication_rejected",
        productionProjectionBlocked: true,
        detail: "Vercel rejected the production credential (authentication failed).",
      };
    }
    if (status === 404) {
      return {
        ...presence,
        ok: false,
        severity: "critical",
        classification: "configured_repository_project_not_accessible",
        productionProjectionBlocked: true,
        detail:
          "Vercel authenticated but the configured repository/project was not accessible.",
      };
    }
    if (
      status !== undefined &&
      status >= 500
    ) {
      return {
        ...presence,
        ok: false,
        severity: "critical",
        classification: "provider_api_temporarily_unavailable",
        productionProjectionBlocked: true,
        detail: "Vercel API is temporarily unavailable.",
      };
    }
    if (/timeout|ECONNRESET|ENOTFOUND|network/i.test(message)) {
      return {
        ...presence,
        ok: false,
        severity: "critical",
        classification: "provider_api_temporarily_unavailable",
        productionProjectionBlocked: true,
        detail: "Vercel API is temporarily unavailable (network error).",
      };
    }
    return {
      ...presence,
      ok: false,
      severity: "critical",
      classification: "provider_authentication_rejected",
      productionProjectionBlocked: true,
      detail: "Vercel production credential verification failed.",
    };
  }
}

export function harnessConfigRequiresVercelProductionToken(config: {
  repos: ProductionSyncRepoLike[];
}): boolean {
  return configRequiresVercelProductionDeploymentVerification(config);
}
