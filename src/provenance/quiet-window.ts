/**
 * Fail-closed quiet-window inspection for production runner workflows.
 * Never cancels runs or prints secrets.
 */

import type { GitHubClient } from "../github/client.js";
import { DEFAULT_RUNNER_REPOSITORY, getProductionWorkflowInstallManifest } from "./production-install-manifests.js";

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

export interface QuietWindowActiveRun {
  id: number;
  name: string;
  status: string;
  htmlUrl: string;
  event: string;
}

export interface QuietWindowObservation {
  observedAt: string;
  activeRunIds: number[];
}

export interface InspectQuietWindowInput {
  client: GitHubClient;
  runnerRepository?: string;
  stateRepository?: { owner: string; repo: string };
  stateBranch?: string;
  priorObservation?: QuietWindowObservation | null;
  observedAt?: string;
}

export interface QuietWindowInspection {
  quiet: boolean;
  observedAt: string;
  activeRuns: QuietWindowActiveRun[];
  tipSha: string | null;
  failClosedReason: string | null;
}

function parseOwnerRepo(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug: ${slug}`);
  }
  return { owner, repo };
}

/** Explicit production dispatch / reconcile surfaces (in addition to install manifest). */
const ALWAYS_WATCHED_WORKFLOW_FILES = [
  "harness-auto-runner.yml",
  "harness-reconcile-revisions.yml",
  "harness-reconcile-production.yml",
] as const;

/** Default gap between quiet-window samples: two 15-minute reconcile polling cycles. */
export const DEFAULT_QUIET_WINDOW_POLL_GAP_MS = 30 * 60 * 1000;

function productionDispatchWorkflowFiles(): string[] {
  const manifest = getProductionWorkflowInstallManifest();
  const files = new Set<string>();
  for (const entry of manifest.entrypoints) {
    const fileName = entry.workflowPath.split("/").pop();
    if (fileName) {
      files.add(fileName);
    }
  }
  for (const fileName of ALWAYS_WATCHED_WORKFLOW_FILES) {
    files.add(fileName);
  }
  return [...files].sort();
}

export async function waitAndInspectQuietWindow(
  input: InspectQuietWindowInput & {
    pollGapMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<QuietWindowInspection & { priorObservation: QuietWindowObservation }> {
  const pollGapMs = input.pollGapMs ?? DEFAULT_QUIET_WINDOW_POLL_GAP_MS;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const {
    pollGapMs: _pollGapMs,
    sleep: _sleep,
    observedAt: firstObservedAt,
    ...sampleInput
  } = input;

  const first = await inspectQuietWindow({
    ...sampleInput,
    observedAt: firstObservedAt,
    priorObservation: null,
  });
  const priorObservation: QuietWindowObservation = {
    observedAt: first.observedAt,
    activeRunIds: first.activeRuns.map((run) => run.id),
  };

  if (priorObservation.activeRunIds.length > 0) {
    return {
      quiet: false,
      observedAt: first.observedAt,
      activeRuns: first.activeRuns,
      tipSha: first.tipSha,
      failClosedReason: "active_workflow_runs",
      priorObservation,
    };
  }

  await sleep(pollGapMs);

  const second = await inspectQuietWindow({
    ...sampleInput,
    priorObservation,
    // Fresh observation timestamp for the second sample.
    observedAt: undefined,
  });
  return { ...second, priorObservation };
}

export async function inspectQuietWindow(
  input: InspectQuietWindowInput,
): Promise<QuietWindowInspection> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const runnerSlug = input.runnerRepository ?? DEFAULT_RUNNER_REPOSITORY;
  const { owner, repo } = parseOwnerRepo(runnerSlug);

  const activeRuns: QuietWindowActiveRun[] = [];
  const activeRunIds: number[] = [];

  for (const workflowFile of productionDispatchWorkflowFiles()) {
    const runs = await input.client.listWorkflowRuns(owner, repo, workflowFile, {
      perPage: 20,
    });
    for (const run of runs) {
      if (!ACTIVE_STATUSES.has(run.status)) {
        continue;
      }
      if (activeRunIds.includes(run.id)) {
        continue;
      }
      activeRunIds.push(run.id);
      activeRuns.push({
        id: run.id,
        name: run.name ?? run.display_title ?? workflowFile,
        status: run.status,
        htmlUrl: run.html_url,
        event: run.event ?? "unknown",
      });
    }
  }

  let tipSha: string | null = null;
  if (input.stateRepository) {
    try {
      const ref = await input.client.getGitRef(
        input.stateRepository.owner,
        input.stateRepository.repo,
        input.stateBranch ?? "p-dev-runtime-state",
      );
      tipSha = ref.object.sha;
    } catch {
      tipSha = null;
    }
  }

  if (!input.priorObservation) {
    return {
      quiet: false,
      observedAt,
      activeRuns,
      tipSha,
      failClosedReason: "insufficient_polling_samples",
    };
  }

  const priorHadActive = input.priorObservation.activeRunIds.length > 0;
  const currentHasActive = activeRunIds.length > 0;
  const quiet = !priorHadActive && !currentHasActive;

  return {
    quiet,
    observedAt,
    activeRuns,
    tipSha,
    failClosedReason: quiet
      ? null
      : currentHasActive
        ? "active_workflow_runs"
        : priorHadActive
          ? "prior_sample_had_active_runs"
          : null,
  };
}
