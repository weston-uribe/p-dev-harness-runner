import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROVENANCE_WRITER_VERSION } from "./launch-surfaces.js";

export const WORKFLOW_INSTALL_MANIFEST_KIND =
  "p-dev.cursor-cloud-agent-workflow-install-manifest.v1" as const;

export const RUNNER_INSTALL_MANIFEST_KIND =
  "p-dev.cursor-cloud-agent-runner-install-manifest.v1" as const;

export const DEFAULT_RUNNER_REPOSITORY = "weston-uribe/p-dev-harness-runner" as const;

export interface ProductionWorkflowEntrypoint {
  workflowPath: string;
  workflowId: string;
  jobId: string;
  entrypointKind: string;
  scriptOrAction: string;
}

export interface WorkflowInstallManifest {
  kind: typeof WORKFLOW_INSTALL_MANIFEST_KIND;
  version: "1";
  entrypoints: ProductionWorkflowEntrypoint[];
}

export interface RunnerDeploymentSlotIdentity {
  repository: string;
  workflowPath: string;
  workflowId: string;
  jobId: string;
}

const HARNESS_RUN_RE = /npm run harness:run\b/;
const HARNESS_RECONCILE_WORKFLOW_RE = /npm run harness:reconcile-workflow\b/;
const HARNESS_RECONCILE_REVISION_RE = /npm run harness:reconcile-revision\b/;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function resolveRepoRoot(repoRoot?: string): string {
  return repoRoot ?? process.cwd();
}

function entrypointKey(entrypoint: Pick<ProductionWorkflowEntrypoint, "workflowPath" | "jobId">): string {
  return `${entrypoint.workflowPath}#${entrypoint.jobId}`;
}

function sortEntrypoints(
  entrypoints: ProductionWorkflowEntrypoint[],
): ProductionWorkflowEntrypoint[] {
  return [...entrypoints].sort((a, b) => {
    const path = a.workflowPath.localeCompare(b.workflowPath);
    if (path !== 0) return path;
    return a.jobId.localeCompare(b.jobId);
  });
}

function detectEntrypointKind(script: string): string | null {
  if (HARNESS_RUN_RE.test(script)) {
    return "harness_run";
  }
  if (HARNESS_RECONCILE_REVISION_RE.test(script)) {
    return "reconcile_bridge";
  }
  if (HARNESS_RECONCILE_WORKFLOW_RE.test(script)) {
    return "dispatch_bridge";
  }
  return null;
}

function parseWorkflowJobs(content: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const lines = content.split("\n");
  let inJobs = false;
  let currentJob: string | null = null;
  const jobChunks: string[] = [];

  const flushJob = () => {
    if (currentJob) {
      jobs.set(currentJob, jobChunks.join("\n"));
    }
    jobChunks.length = 0;
  };

  for (const line of lines) {
    if (!inJobs && /^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      flushJob();
      currentJob = jobMatch[1]!;
      continue;
    }
    if (/^[^\s]/.test(line) && line.trim() !== "") {
      flushJob();
      currentJob = null;
      inJobs = false;
      continue;
    }
    if (currentJob) {
      jobChunks.push(line);
    }
  }
  flushJob();
  return jobs;
}

function scanJobScripts(jobBody: string): string[] {
  const scripts: string[] = [];
  for (const line of jobBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("run:")) {
      scripts.push(trimmed.slice("run:".length).trim());
    }
    if (trimmed.includes("npm run harness:")) {
      scripts.push(trimmed);
    }
  }
  return scripts;
}

export function discoverProductionWorkflowEntrypoints(
  repoRoot?: string,
): ProductionWorkflowEntrypoint[] {
  const root = resolveRepoRoot(repoRoot);
  const workflowsDir = join(root, ".github", "workflows");
  const files = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

  const discovered: ProductionWorkflowEntrypoint[] = [];
  const seen = new Set<string>();

  for (const fileName of files) {
    const workflowPath = `.github/workflows/${fileName}`;
    const workflowId = basename(fileName).replace(/\.(ya?ml)$/i, "");
    const content = readFileSync(join(workflowsDir, fileName), "utf8");
    const jobs = parseWorkflowJobs(content);

    for (const [jobId, jobBody] of jobs) {
      const scripts = scanJobScripts(jobBody);
      for (const script of scripts) {
        const kind = detectEntrypointKind(script);
        if (!kind) {
          continue;
        }
        const key = `${workflowPath}#${jobId}#${kind}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        discovered.push({
          workflowPath,
          workflowId,
          jobId,
          entrypointKind: kind,
          scriptOrAction: script.match(/npm run harness:[^\s|]+/)?.[0] ?? script,
        });
      }
    }
  }

  return sortEntrypoints(discovered);
}

export function getProductionWorkflowInstallManifest(
  repoRoot?: string,
): WorkflowInstallManifest {
  return {
    kind: WORKFLOW_INSTALL_MANIFEST_KIND,
    version: "1",
    entrypoints: discoverProductionWorkflowEntrypoints(repoRoot),
  };
}

export function workflowInstallManifestDigest(
  manifest: WorkflowInstallManifest = getProductionWorkflowInstallManifest(),
): string {
  const canonical = {
    kind: manifest.kind,
    version: manifest.version,
    entrypoints: sortEntrypoints(manifest.entrypoints).map((entry) => ({
      workflowPath: entry.workflowPath,
      workflowId: entry.workflowId,
      jobId: entry.jobId,
      entrypointKind: entry.entrypointKind,
      scriptOrAction: entry.scriptOrAction,
    })),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

export function productionWorkflowInstallManifestPin(repoRoot?: string): {
  kind: typeof WORKFLOW_INSTALL_MANIFEST_KIND;
  version: "1";
  digest: string;
  entrypoints: string[];
} {
  const manifest = getProductionWorkflowInstallManifest(repoRoot);
  return {
    kind: WORKFLOW_INSTALL_MANIFEST_KIND,
    version: "1",
    digest: workflowInstallManifestDigest(manifest),
    entrypoints: manifest.entrypoints.map(entrypointKey),
  };
}

const MANAGED_RUNNER_ENTRYPOINT_KINDS = new Set([
  "harness_run",
  "reconcile_bridge",
  "dispatch_bridge",
]);

export function getExpectedRunnerDeploymentSlots(
  repoRoot?: string,
): RunnerDeploymentSlotIdentity[] {
  const manifest = getProductionWorkflowInstallManifest(repoRoot);
  return manifest.entrypoints
    .filter((entry) => MANAGED_RUNNER_ENTRYPOINT_KINDS.has(entry.entrypointKind))
    .map((entry) => ({
      repository: DEFAULT_RUNNER_REPOSITORY,
      workflowPath: entry.workflowPath,
      workflowId: entry.workflowId,
      jobId: entry.jobId,
    }))
    .sort((a, b) => {
      const path = a.workflowPath.localeCompare(b.workflowPath);
      if (path !== 0) return path;
      return a.jobId.localeCompare(b.jobId);
    });
}

export function runnerInstallationId(
  slot: RunnerDeploymentSlotIdentity,
  writerVersion: string = PROVENANCE_WRITER_VERSION,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        kind: RUNNER_INSTALL_MANIFEST_KIND,
        version: "1",
        writerVersion,
        repository: slot.repository,
        workflowPath: slot.workflowPath,
        workflowId: slot.workflowId,
        jobId: slot.jobId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function runnerInstallManifestDigest(
  slots: RunnerDeploymentSlotIdentity[] = getExpectedRunnerDeploymentSlots(),
  writerVersion: string = PROVENANCE_WRITER_VERSION,
): string {
  const canonical = {
    kind: RUNNER_INSTALL_MANIFEST_KIND,
    version: "1",
    writerVersion,
    slots: slots.map((slot) => ({
      repository: slot.repository,
      workflowPath: slot.workflowPath,
      workflowId: slot.workflowId,
      jobId: slot.jobId,
      installationId: runnerInstallationId(slot, writerVersion),
    })),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

export function productionRunnerInstallManifestPin(
  repoRoot?: string,
  writerVersion: string = PROVENANCE_WRITER_VERSION,
): {
  kind: typeof RUNNER_INSTALL_MANIFEST_KIND;
  version: "1";
  digest: string;
  installationIds: string[];
} {
  const slots = getExpectedRunnerDeploymentSlots(repoRoot);
  return {
    kind: RUNNER_INSTALL_MANIFEST_KIND,
    version: "1",
    digest: runnerInstallManifestDigest(slots, writerVersion),
    installationIds: slots.map((slot) => runnerInstallationId(slot, writerVersion)),
  };
}

export { entrypointKey as workflowEntrypointKey };
