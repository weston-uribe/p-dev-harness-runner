import type { SetupGuiViewModel } from "./gui-view-model.js";
import { parseGitHubRepoSlug } from "./github-repo-slug.js";

export const STALE_SMOKE_HARNESS_PATTERN = /pdh-smoke-harness-/i;
export const STALE_SMOKE_TARGET_PATTERN = /pdh-smoke-target-/i;

export type StaleSmokeRepoKind =
  | "harness-dispatch"
  | "target-repo"
  | "allowed-target-repo";

export interface StaleSmokeRepoFinding {
  kind: StaleSmokeRepoKind;
  value: string;
  source: string;
}

export interface StaleSmokeDiagnostics {
  hasStaleConfig: boolean;
  findings: StaleSmokeRepoFinding[];
  staleHarnessDispatchRepo?: string;
  staleTargetRepos: string[];
  suggestedHarnessDispatchRepo?: string;
}

export function isStaleSmokeHarnessRepo(value: string): boolean {
  return STALE_SMOKE_HARNESS_PATTERN.test(value.trim());
}

export function isStaleSmokeTargetRepo(value: string): boolean {
  return STALE_SMOKE_TARGET_PATTERN.test(value.trim());
}

export function detectStaleSmokeRepoFindings(input: {
  harnessDispatchRepo?: string;
  configSummary?: SetupGuiViewModel["configSummary"];
  targetRepos?: Array<{ id: string; targetRepo: string }>;
  allowedTargetRepos?: string[];
}): StaleSmokeRepoFinding[] {
  const findings: StaleSmokeRepoFinding[] = [];

  if (
    input.harnessDispatchRepo &&
    isStaleSmokeHarnessRepo(input.harnessDispatchRepo)
  ) {
    findings.push({
      kind: "harness-dispatch",
      value: input.harnessDispatchRepo,
      source: "GITHUB_DISPATCH_REPOSITORY",
    });
  }

  const repos =
    input.configSummary?.repos ??
    input.targetRepos?.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
      baseBranch: "main",
      productionBranch: "main",
    })) ??
    [];

  const allowedTargetRepos =
    input.configSummary?.allowedTargetRepos ?? input.allowedTargetRepos ?? [];

  for (const repo of repos) {
    if (isStaleSmokeTargetRepo(repo.targetRepo)) {
      findings.push({
        kind: "target-repo",
        value: repo.targetRepo,
        source: `repos[].targetRepo (${repo.id})`,
      });
    }
  }

  for (const allowedRepo of allowedTargetRepos) {
    if (isStaleSmokeTargetRepo(allowedRepo)) {
      findings.push({
        kind: "allowed-target-repo",
        value: allowedRepo,
        source: "allowedTargetRepos[]",
      });
    }
  }

  return findings;
}

export function deriveStaleSmokeDiagnostics(input: {
  harnessDispatchRepo?: string;
  gitRemoteOriginUrl?: string | null;
  configSummary?: SetupGuiViewModel["configSummary"];
  targetRepos?: Array<{ id: string; targetRepo: string }>;
  allowedTargetRepos?: string[];
}): StaleSmokeDiagnostics {
  const findings = detectStaleSmokeRepoFindings(input);
  const suggestedHarnessDispatchRepo = input.gitRemoteOriginUrl
    ? parseGitHubRepoSlug(input.gitRemoteOriginUrl) ?? undefined
    : undefined;

  const staleHarnessDispatchRepo = findings.find(
    (finding) => finding.kind === "harness-dispatch",
  )?.value;

  const staleTargetRepos = [
    ...new Set(
      findings
        .filter(
          (finding) =>
            finding.kind === "target-repo" ||
            finding.kind === "allowed-target-repo",
        )
        .map((finding) => finding.value),
    ),
  ];

  return {
    hasStaleConfig: findings.length > 0,
    findings,
    staleHarnessDispatchRepo,
    staleTargetRepos,
    suggestedHarnessDispatchRepo,
  };
}

export function remoteSetupBlockedByStaleSmoke(
  diagnostics: StaleSmokeDiagnostics,
): boolean {
  return diagnostics.hasStaleConfig;
}

export function shouldSuppressRemoteDownstreamStatus(
  diagnostics: StaleSmokeDiagnostics,
  harnessRepoAccess: "available" | "denied" | "unknown",
): boolean {
  return (
    diagnostics.hasStaleConfig &&
    (diagnostics.staleHarnessDispatchRepo !== undefined ||
      harnessRepoAccess === "denied")
  );
}
