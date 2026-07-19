import { execFileSync } from "node:child_process";
import os from "node:os";

export type ExecutionEnvironmentKind =
  | "github_actions"
  | "codespaces"
  | "local_dev";

export interface ExecutionEnvironmentInfo {
  kind: ExecutionEnvironmentKind;
  marker: string;
  hostname?: string;
  codespaceName?: string;
  githubRunId?: string;
  githubWorkflow?: string;
  gitBranch?: string;
  gitSha?: string;
}

export interface ExecutionEnvironmentDetectOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  hostname?: string;
  readGitInfo?: (cwd: string) => { branch?: string; sha?: string };
}

function isTruthyEnv(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function readGitInfoFromRepo(cwd: string): { branch?: string; sha?: string } {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      branch: branch && branch !== "HEAD" ? branch : undefined,
      sha: sha ? sha.slice(0, 12) : undefined,
    };
  } catch {
    return {};
  }
}

function resolveGitInfo(
  env: Record<string, string | undefined>,
  cwd: string,
  readGitInfo: (cwd: string) => { branch?: string; sha?: string },
): { branch?: string; sha?: string } {
  const fromEnv: { branch?: string; sha?: string } = {};
  if (env.GITHUB_SHA) {
    fromEnv.sha = env.GITHUB_SHA.slice(0, 12);
  }
  const branchFromEnv =
    env.GITHUB_REF_NAME?.trim() ||
    env.GITHUB_HEAD_REF?.trim() ||
    undefined;
  if (branchFromEnv) {
    fromEnv.branch = branchFromEnv;
  }

  if (fromEnv.branch && fromEnv.sha) {
    return fromEnv;
  }

  const fromGit = readGitInfo(cwd);
  return {
    branch: fromEnv.branch ?? fromGit.branch,
    sha: fromEnv.sha ?? fromGit.sha,
  };
}

function resolveExecutionEnvironmentKind(
  env: Record<string, string | undefined>,
): ExecutionEnvironmentKind {
  if (isTruthyEnv(env.GITHUB_ACTIONS)) {
    return "github_actions";
  }
  if (isTruthyEnv(env.CODESPACES) || Boolean(env.CODESPACE_NAME?.trim())) {
    return "codespaces";
  }
  return "local_dev";
}

export function formatExecutionEnvironmentMarker(
  info: Pick<
    ExecutionEnvironmentInfo,
    | "kind"
    | "hostname"
    | "codespaceName"
    | "githubRunId"
    | "githubWorkflow"
  >,
): string {
  switch (info.kind) {
    case "github_actions": {
      const runId = info.githubRunId?.trim() || "unknown run";
      const workflow = info.githubWorkflow?.trim();
      return workflow
        ? `Executed in GitHub Actions: ${runId} / ${workflow}`
        : `Executed in GitHub Actions: ${runId}`;
    }
    case "codespaces":
      return `Executed in GitHub Codespaces: ${
        info.codespaceName?.trim() || info.hostname?.trim() || "unknown"
      }`;
    case "local_dev":
      return `Executed in local dev: ${info.hostname?.trim() || "unknown"}`;
  }
}

export function detectExecutionEnvironment(
  options: ExecutionEnvironmentDetectOptions = {},
): ExecutionEnvironmentInfo {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const hostname = options.hostname ?? os.hostname();
  const kind = resolveExecutionEnvironmentKind(env);
  const codespaceName = env.CODESPACE_NAME?.trim() || undefined;
  const githubRunId = env.GITHUB_RUN_ID?.trim() || undefined;
  const githubWorkflow = env.GITHUB_WORKFLOW?.trim() || undefined;
  const git = resolveGitInfo(env, cwd, options.readGitInfo ?? readGitInfoFromRepo);

  const info: ExecutionEnvironmentInfo = {
    kind,
    marker: "",
    hostname,
    codespaceName,
    githubRunId,
    githubWorkflow,
    gitBranch: git.branch,
    gitSha: git.sha,
  };
  info.marker = formatExecutionEnvironmentMarker(info);
  return info;
}

export function appendExecutionEnvironmentMetadataLines(
  lines: string[],
  options: ExecutionEnvironmentDetectOptions = {},
): string[] {
  const info = detectExecutionEnvironment(options);
  lines.push(`execution_environment: ${info.kind}`);
  lines.push(`execution_environment_marker: ${info.marker}`);
  if (info.hostname) {
    lines.push(`hostname: ${info.hostname}`);
  }
  if (info.codespaceName) {
    lines.push(`codespace_name: ${info.codespaceName}`);
  }
  if (info.githubRunId) {
    lines.push(`github_run_id: ${info.githubRunId}`);
  }
  if (info.githubWorkflow) {
    lines.push(`github_workflow: ${info.githubWorkflow}`);
  }
  if (info.gitBranch) {
    lines.push(`git_branch: ${info.gitBranch}`);
  }
  if (info.gitSha) {
    lines.push(`git_sha: ${info.gitSha}`);
  }
  return lines;
}

export function logExecutionEnvironmentMarker(
  options: ExecutionEnvironmentDetectOptions = {},
): ExecutionEnvironmentInfo {
  const info = detectExecutionEnvironment(options);
  console.log(info.marker);
  return info;
}
