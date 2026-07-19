import { access } from "node:fs/promises";
import { loadHarnessConfig } from "../config/load-config.js";
import { validateRepoClosure } from "../config/load-config.js";
import type { HarnessConfig } from "../config/types.js";
import { normalizeHarnessEnvPaths } from "../gui/repo-root.js";
import { resolveConfigSource } from "../config/resolve-config.js";
import { resolveHarnessDispatchRepo } from "./harness-dispatch-repo.js";
import { redactKnownSecretValues } from "./redact-secrets.js";
import { summarizeCursorModelSettings } from "./model-settings.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import {
  loadSecretFromEnvLocal,
  verifySetupService,
  verifySetupTargetRepo,
} from "./service-verification.js";

export type LocalReadinessCheckStatus = "passed" | "failed";

export interface LocalReadinessCheckResult {
  id: string;
  label: string;
  status: LocalReadinessCheckStatus;
  detail?: string;
  action?: string;
}

export interface LocalReadinessRunResult {
  checks: LocalReadinessCheckResult[];
  allPassed: boolean;
}

export type LocalReadinessProgressEvent =
  | { type: "check-started"; id: string; label: string }
  | { type: "check-completed"; check: LocalReadinessCheckResult }
  | { type: "run-completed"; allPassed: boolean }
  | { type: "run-failed"; message: string };

type LocalReadinessEmit = (event: LocalReadinessProgressEvent) => void;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function redactDetail(message: string, secrets: string[]): string {
  return redactKnownSecretValues(message, secrets);
}

function passed(
  id: string,
  label: string,
  detail?: string,
): LocalReadinessCheckResult {
  return { id, label, status: "passed", detail };
}

function failed(
  id: string,
  label: string,
  detail: string,
  action: string,
  secrets: string[] = [],
): LocalReadinessCheckResult {
  return {
    id,
    label,
    status: "failed",
    detail: redactDetail(detail, secrets),
    action: redactDetail(action, secrets),
  };
}

function emitCheckStarted(
  emit: LocalReadinessEmit | undefined,
  id: string,
  label: string,
): void {
  emit?.({ type: "check-started", id, label });
}

function emitCheckCompleted(
  emit: LocalReadinessEmit | undefined,
  checks: LocalReadinessCheckResult[],
  check: LocalReadinessCheckResult,
): void {
  checks.push(check);
  emit?.({ type: "check-completed", check });
}

async function executeLocalReadinessChecks(options: {
  cwd: string;
  emit?: LocalReadinessEmit;
}): Promise<LocalReadinessRunResult> {
  const { cwd, emit } = options;
  normalizeHarnessEnvPaths(cwd);
  const paths = resolveLocalFilePaths(cwd);
  const checks: LocalReadinessCheckResult[] = [];
  const secrets: string[] = [];
  for (const key of ["LINEAR_API_KEY", "CURSOR_API_KEY", "GITHUB_TOKEN"] as const) {
    const value = await loadSecretFromEnvLocal({ cwd, key });
    if (value) {
      secrets.push(value);
    }
  }

  const envExists = await fileExists(paths.envLocal);
  const configExists = await fileExists(paths.configLocal);

  let config: HarnessConfig | null = null;
  let configParseError: string | undefined;

  try {
    const loaded = await loadHarnessConfig({ baseDir: cwd });
    config = loaded.config;
  } catch (error) {
    configParseError =
      error instanceof Error ? error.message : String(error);
  }

  if (configParseError) {
    emitCheckStarted(emit, "config-parses", "Rechecking generated harness config");
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "config-parses",
        "Rechecking generated harness config",
        configParseError,
        "Return to Step 2 and fix .harness/config.local.json, then preview and apply again.",
      ),
    );
  } else if (config) {
    emitCheckStarted(emit, "config-parses", "Rechecking generated harness config");
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "config-parses",
        "Rechecking generated harness config",
        resolveConfigSource({ baseDir: cwd }).label,
      ),
    );
  } else {
    emitCheckStarted(emit, "config-parses", "Rechecking generated harness config");
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "config-parses",
        "Rechecking generated harness config",
        "Harness config could not be resolved.",
        "Return to Step 2 and create local setup files again.",
      ),
    );
  }

  emitCheckStarted(emit, "env-local-exists", ".env.local is present");
  if (envExists) {
    emitCheckCompleted(emit, checks, passed("env-local-exists", ".env.local is present"));
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "env-local-exists",
        ".env.local is present",
        "The local environment file is missing.",
        "Return to Step 2 and create local setup files again.",
      ),
    );
  }

  emitCheckStarted(emit, "harness-dispatch-repo-resolved", "Harness dispatch repo is resolved");
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({ cwd });
  if (harnessDispatchRepo.resolved && harnessDispatchRepo.repo) {
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "harness-dispatch-repo-resolved",
        "Harness dispatch repo is resolved",
        harnessDispatchRepo.repo,
      ),
    );
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "harness-dispatch-repo-resolved",
        "Harness dispatch repo is resolved",
        harnessDispatchRepo.detail ??
          "Harness dispatch repo could not be resolved from local setup.",
        "Return to Step 4, enter your harness repo, and use Verify and use harness repo.",
      ),
    );
  }

  emitCheckStarted(emit, "config-local-exists", ".harness/config.local.json is present");
  if (configExists) {
    emitCheckCompleted(
      emit,
      checks,
      passed("config-local-exists", ".harness/config.local.json is present"),
    );
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "config-local-exists",
        ".harness/config.local.json is present",
        "The local harness config file is missing.",
        "Return to Step 2 and create local setup files again.",
      ),
    );
  }

  if (config) {
    emitCheckStarted(
      emit,
      "target-repos-closure",
      "Target repos are allowed in harness config",
    );
    try {
      validateRepoClosure(config);
      emitCheckCompleted(
        emit,
        checks,
        passed(
          "target-repos-closure",
          "Target repos are allowed in harness config",
        ),
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      emitCheckCompleted(
        emit,
        checks,
        failed(
          "target-repos-closure",
          "Target repos are allowed in harness config",
          detail,
          "Update .harness/config.local.json so allowedTargetRepos includes every configured target repo.",
        ),
      );
    }

    emitCheckStarted(emit, "model-policy", "Cursor model policy resolves");
    const model = summarizeCursorModelSettings(config);
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "model-policy",
        "Cursor model policy resolves",
        `${model.resolvedModelId} (${model.source})`,
      ),
    );
  }

  emitCheckStarted(emit, "linear-key", "Linear API key works");
  const linearResult = await verifySetupService({
    cwd,
    service: "linear",
  });
  if (linearResult.status === "connected") {
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "linear-key",
        "Linear API key works",
        linearResult.label
          ? `Connected as ${linearResult.label}.`
          : linearResult.message,
      ),
    );
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "linear-key",
        "Linear API key works",
        linearResult.message,
        "Return to Step 1 and verify your Linear API key, then recreate local setup files if needed.",
        secrets,
      ),
    );
  }

  emitCheckStarted(emit, "cursor-key", "Cursor API key works");
  const cursorResult = await verifySetupService({
    cwd,
    service: "cursor",
  });
  if (cursorResult.status === "connected") {
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "cursor-key",
        "Cursor API key works",
        cursorResult.message,
      ),
    );
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "cursor-key",
        "Cursor API key works",
        cursorResult.message,
        "Return to Step 1 and verify your Cursor API key, then recreate local setup files if needed.",
        secrets,
      ),
    );
  }

  emitCheckStarted(emit, "github-token", "GitHub token supports guided setup");
  const githubResult = await verifySetupService({
    cwd,
    service: "github",
  });
  if (githubResult.status === "connected") {
    const githubDetail = githubResult.label
      ? `Connected as ${githubResult.label}.`
      : githubResult.message;
    emitCheckCompleted(
      emit,
      checks,
      passed(
        "github-token",
        "GitHub token supports guided setup",
        githubResult.limitation
          ? `${githubDetail} ${githubResult.limitation}`
          : githubDetail,
      ),
    );
  } else {
    emitCheckCompleted(
      emit,
      checks,
      failed(
        "github-token",
        "GitHub token supports guided setup",
        githubResult.message,
        "Return to Step 1 and update GITHUB_TOKEN with repo + workflow (classic PAT) or Contents write + Workflows write on target repos (fine-grained PAT), then verify again.",
        secrets,
      ),
    );
  }

  if (config && githubResult.status === "connected") {
    for (const repo of config.repos) {
      const label = `Target repo ${repo.targetRepo} supports workflow install`;
      emitCheckStarted(emit, `target-repo-${repo.id}`, label);
      const repoResult = await verifySetupTargetRepo({
        cwd,
        targetRepo: repo.targetRepo,
      });
      const slug = repoResult.repoSlug ?? repo.targetRepo;
      const resolvedLabel = `Target repo ${slug} supports workflow install`;
      if (
        repoResult.status === "connected" &&
        repoResult.workflowInstallReady !== false
      ) {
        const detail = repoResult.limitation
          ? `${repoResult.message} ${repoResult.limitation}`
          : repoResult.message;
        emitCheckCompleted(
          emit,
          checks,
          passed(`target-repo-${repo.id}`, resolvedLabel, detail),
        );
      } else {
        emitCheckCompleted(
          emit,
          checks,
          failed(
            `target-repo-${repo.id}`,
            resolvedLabel,
            repoResult.message,
            "Return to Step 2 and verify repo + workflow access, or update GITHUB_TOKEN in Step 1 with workflow permissions and verify again.",
            secrets,
          ),
        );
      }
    }
  } else if (config && config.repos.length > 0) {
    for (const repo of config.repos) {
      const label = `Target repo ${repo.targetRepo} supports workflow install`;
      emitCheckStarted(emit, `target-repo-${repo.id}`, label);
      emitCheckCompleted(
        emit,
        checks,
        failed(
          `target-repo-${repo.id}`,
          label,
          "GitHub token must support guided setup before target repo workflow access can be checked.",
          "Fix your GitHub token in Step 1 first.",
        ),
      );
    }
  }

  const allPassed = checks.every((check) => check.status === "passed");
  emit?.({ type: "run-completed", allPassed });
  return { checks, allPassed };
}

export async function runLocalReadinessChecks(options?: {
  cwd?: string;
}): Promise<LocalReadinessRunResult> {
  const cwd = options?.cwd ?? process.cwd();
  return executeLocalReadinessChecks({ cwd });
}

export async function* runLocalReadinessChecksProgress(options?: {
  cwd?: string;
}): AsyncGenerator<LocalReadinessProgressEvent> {
  const cwd = options?.cwd ?? process.cwd();
  const events: LocalReadinessProgressEvent[] = [];
  let resolveNext: (() => void) | null = null;

  const emit: LocalReadinessEmit = (event) => {
    events.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  const runPromise = executeLocalReadinessChecks({ cwd, emit }).catch((error) => {
    const message =
      error instanceof Error ? error.message : "Local readiness check failed";
    emit({ type: "run-failed", message });
  });

  while (true) {
    if (events.length === 0) {
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
      await runPromise;
      if (events.length === 0) {
        break;
      }
    }
    while (events.length > 0) {
      const event = events.shift();
      if (!event) {
        break;
      }
      yield event;
      if (event.type === "run-completed" || event.type === "run-failed") {
        return;
      }
    }
  }
}
