import { MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER } from "./remote-actions.js";

export interface GeneratedInstructions {
  summary: string;
  steps: string[];
  command?: string;
}

const TARGET_WORKFLOW_PATH =
  ".github/workflows/trigger-harness-production-sync.yml";

function resolveHarnessRepoLabel(harnessRepo?: string): string {
  return harnessRepo?.trim() || MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER;
}

export function generateHarnessConfigB64Instructions(options?: {
  configPath?: string;
}): GeneratedInstructions {
  const configPath = options?.configPath ?? ".harness/config.local.json";
  const command = `base64 < ${configPath} | tr -d '\\n'`;

  return {
    summary:
      "Encode the full private harness config for the HARNESS_CONFIG_JSON_B64 GitHub Actions secret.",
    command,
    steps: [
      "Maintain the full private harness config locally at .harness/config.local.json.",
      "Ensure every managed repo appears in both repos[] and allowedTargetRepos[].",
      `Run: ${command}`,
      "Copy the single-line output into the harness repo GitHub Actions secret HARNESS_CONFIG_JSON_B64.",
      "Do not commit the encoded value or private config to the public harness repo.",
    ],
  };
}

export function generateGitHubSecretInstructions(options?: {
  harnessRepo?: string;
  includeVercelToken?: boolean;
}): GeneratedInstructions {
  const harnessRepo = resolveHarnessRepoLabel(options?.harnessRepo);
  const secretNames = [
    "HARNESS_CONFIG_JSON_B64",
    "LINEAR_API_KEY",
    "CURSOR_API_KEY",
    "HARNESS_GITHUB_TOKEN",
    ...(options?.includeVercelToken ? (["VERCEL_TOKEN"] as const) : []),
  ];

  return {
    summary: `Manual GitHub Actions secret setup for ${harnessRepo}.`,
    steps: [
      `Open GitHub repository settings for ${harnessRepo}.`,
      "Navigate to Settings → Secrets and variables → Actions.",
      `Create or update these secret names: ${secretNames.join(", ")}.`,
      "Set HARNESS_CONFIG_JSON_B64 from the base64-encoded full private harness config.",
      "Set LINEAR_API_KEY, CURSOR_API_KEY, and HARNESS_GITHUB_TOKEN from your operator credentials.",
      ...(options?.includeVercelToken
        ? [
            "Set VERCEL_TOKEN when any target repo requires Vercel production deployment verification for terminal Merged / Deployed projection.",
          ]
        : []),
      "Never print secret values in logs, docs, PR comments, or generated setup previews.",
    ],
  };
}

export function generateTargetRepoWorkflowInstructions(options?: {
  harnessRepo?: string;
  repoConfigId?: string;
  targetRepoSlug?: string;
  productionBranch?: string;
}): GeneratedInstructions {
  const harnessRepo = resolveHarnessRepoLabel(options?.harnessRepo);
  const repoConfigId = options?.repoConfigId ?? "target-app";
  const targetRepoSlug = options?.targetRepoSlug ?? "owner/example-target-app";
  const productionBranch = options?.productionBranch ?? "main";

  return {
    summary:
      "Manual target repo workflow install for production promotion dispatch.",
    steps: [
      `In the example target repo, create ${TARGET_WORKFLOW_PATH}.`,
      `Set the harness dispatch URL to https://api.github.com/repos/${harnessRepo}/dispatches.`,
      `Set payload repo to the private config repos[].id value (${repoConfigId}).`,
      `Set payload sourceRepo to the target repo slug (${targetRepoSlug}).`,
      `Restrict the workflow to production branch pushes (${productionBranch}).`,
      "Store HARNESS_DISPATCH_TOKEN in the target repo only; do not place merge-capable tokens in Vercel.",
      "Preferred first behavior: open a PR with the workflow file instead of direct push.",
    ],
  };
}

export function generateCloudValidationInstructions(): GeneratedInstructions {
  return {
    summary: "Safe cloud validation sequence after local doctor passes.",
    steps: [
      "Run workflow_dispatch with sync_repo=harness for a config smoke test.",
      "Run workflow_dispatch with sync_repo=<target-app> and sync_dry_run=true.",
      "Inspect the run output before enabling live production sync.",
      "Set sync_dry_run=false only when ready for real Linear status updates.",
    ],
  };
}
