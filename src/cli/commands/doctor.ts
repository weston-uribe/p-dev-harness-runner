import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { Cursor } from "@cursor/sdk";
import { loadHarnessConfig, validateRepoClosure } from "../../config/load-config.js";
import type { HarnessConfig } from "../../config/types.js";
import { roleModelsSchema } from "../../config/role-models.js";
import {
  resolveBuilderModel,
  resolveModelForRole,
  resolvePlannerModel,
  summarizeRoleModelSource,
} from "../../cursor/model.js";
import {
  isWorkflowCloudConfigSynchronized,
  readWorkflowModelsSyncEvidence,
} from "../../setup/workflow-models-sync-evidence.js";
import { resolveLocalFilePaths } from "../../setup/setup-state.js";
import { formatHarnessDispatchRepo, resolveHarnessDispatchRepo } from "../../setup/harness-dispatch-repo.js";
import {
  assertBaseBranchExists,
  assertHeadBranchWritePermission,
} from "../../github/base-branch.js";
import { GitHubClient, pingGitHub } from "../../github/client.js";
import { pingLinear } from "../../linear/client.js";
import { detectNoncanonicalConfigOverrides } from "../../workflow/canonical-workflow-validation.js";
import {
  doctorChecksFailed,
  formatDoctorCheckLine,
  type DoctorCheckResult,
} from "../../setup/doctor-summary.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";

export interface DoctorOptions {
  configPath: string;
  profile?: "full" | "merge";
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const profile = options.profile ?? "full";
  const checks: DoctorCheckResult[] = [];
  let config: HarnessConfig | null = null;

  try {
    const loaded = await loadHarnessConfig({ configPath: options.configPath });
    config = loaded.config;
    checks.push({
      label: "harness config valid",
      ok: true,
      detail: loaded.source.label,
    });

    validateRepoClosure(config);
    checks.push({
      label: "allowedTargetRepos covers all repo mappings",
      ok: true,
    });

    const overrideViolations = detectNoncanonicalConfigOverrides(config);
    checks.push({
      label: "canonical workflow status names",
      ok: overrideViolations.length === 0,
      detail:
        overrideViolations.length === 0
          ? "no noncanonical linear status overrides"
          : overrideViolations.map((violation) => violation.message).join("; "),
    });

    const runsDir = path.resolve(config.logDirectory);
    await mkdir(runsDir, { recursive: true });
    await access(runsDir, constants.W_OK);
    checks.push({
      label: "runs/ directory writable",
      ok: true,
      detail: runsDir,
    });

    if (config) {
      const roleModelsParse = roleModelsSchema.safeParse(config.roleModels ?? {});
      checks.push({
        label: "roleModels durable shape",
        ok: roleModelsParse.success,
        detail: roleModelsParse.success
          ? "planner/builder selections structurally valid"
          : roleModelsParse.error.issues
              .map((issue: { message: string }) => issue.message)
              .join("; "),
      });

      const planner = resolvePlannerModel(config);
      const builder = resolveBuilderModel(config);
      checks.push({
        label: "Planner model resolves",
        ok: Boolean(planner.id),
        detail: `configured (${planner.id}) via ${summarizeRoleModelSource(config, "planner")}`,
      });
      checks.push({
        label: "Builder model resolves",
        ok: Boolean(builder.id),
        detail: `configured (${builder.id}) via ${summarizeRoleModelSource(config, "builder")}`,
      });

      const obsoleteKeys = ["revisionModel", "repairModel"].filter(
        (key) => key in (config as Record<string, unknown>),
      );
      checks.push({
        label: "obsolete revision/repair model keys absent",
        ok: obsoleteKeys.length === 0,
        detail:
          obsoleteKeys.length === 0
            ? "no legacy per-phase model keys"
            : `found: ${obsoleteKeys.join(", ")}`,
      });

      try {
        const cwd = path.dirname(path.resolve(options.configPath));
        const localPaths = resolveLocalFilePaths(cwd);
        let packagedConfigPresent = false;
        try {
          await access(localPaths.configLocal);
          packagedConfigPresent = true;
        } catch {
          packagedConfigPresent = false;
        }

        if (!packagedConfigPresent) {
          checks.push({
            label: "Workflow cloud configuration",
            ok: true,
            skipped: true,
            detail: "skipped for explicit config path without .harness/config.local.json",
          });
          checks.push({
            label: "Workflow sync evidence",
            ok: true,
            skipped: true,
            detail: "skipped for explicit config path without packaged local config",
          });
          checks.push({
            label: "Harness dispatch repository",
            ok: true,
            skipped: true,
            detail: "skipped for explicit config path without packaged local config",
          });
        } else {
          const { readCurrentConfigFingerprint } = await import(
            "../../setup/workflow-model-sync.js"
          );
          const fingerprint = await readCurrentConfigFingerprint(cwd);
          const evidence = await readWorkflowModelsSyncEvidence(cwd);
          const synchronized = isWorkflowCloudConfigSynchronized({
            currentFingerprint: fingerprint,
            evidence,
          });
          checks.push({
            label: "Workflow cloud configuration",
            ok: synchronized,
            detail: synchronized
              ? "synchronized"
              : evidence
                ? "needs synchronization"
                : "needs synchronization (no sync evidence)",
          });
          checks.push({
            label: "Workflow sync evidence",
            ok: Boolean(evidence),
            detail: evidence
              ? `recorded at ${evidence.syncedAt}`
              : "needs reconstruction (bookkeeping may be missing)",
          });

          const dispatchRepo = await resolveHarnessDispatchRepo({ cwd });
          checks.push({
            label: "Harness dispatch repository",
            ok: dispatchRepo.resolved,
            detail: formatHarnessDispatchRepo(dispatchRepo),
          });
        }
      } catch (error) {
        checks.push({
          label: "Workflow cloud configuration",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    checks.push({
      label: "harness.config.json valid",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (process.env.LINEAR_API_KEY) {
    try {
      const name = await pingLinear(process.env.LINEAR_API_KEY);
      checks.push({
        label: "LINEAR_API_KEY set",
        ok: true,
        detail: `authenticated as ${name}`,
      });
    } catch (error) {
      checks.push({
        label: "LINEAR_API_KEY set",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      label: "LINEAR_API_KEY set",
      ok: false,
      detail: "required for live planning runs",
    });
  }

  if (process.env.CURSOR_API_KEY) {
    checks.push({
      label: "CURSOR_API_KEY set",
      ok: true,
    });

    try {
      const models = await Cursor.models.list({
        apiKey: process.env.CURSOR_API_KEY,
      });
      const count = models.length;
      checks.push({
        label: "Cursor models.list()",
        ok: true,
        detail: `${count} model(s) available`,
      });

      if (config) {
        for (const role of ["planner", "builder"] as const) {
          const selection = resolveModelForRole(config, role);
          const knownModel = models.some((model) => model.id === selection.id);
          checks.push({
            label: `${role} model catalog validation`,
            ok: knownModel,
            detail: knownModel
              ? "model available in current Cursor catalog"
              : `model "${selection.id}" not found in current catalog`,
          });
        }
      }
    } catch (error) {
      checks.push({
        label: "Cursor models.list()",
        ok: true,
        detail: `warn: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    try {
      const repos = await Cursor.repositories.list({
        apiKey: process.env.CURSOR_API_KEY,
      });
      const count = repos.length;
      checks.push({
        label: "Cursor repositories.list()",
        ok: true,
        detail: `${count} connected repo(s)`,
      });
    } catch (error) {
      checks.push({
        label: "Cursor repositories.list()",
        ok: true,
        detail: `warn: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else if (profile === "merge") {
    checks.push({
      label: "CURSOR_API_KEY set",
      ok: true,
      skipped: true,
      detail: "required only when merge integration repair needs a Cursor agent",
    });
  } else {
    checks.push({
      label: "CURSOR_API_KEY set",
      ok: false,
      detail: "required for live planning runs",
    });
  }

  if (process.env.GITHUB_TOKEN) {
    try {
      const login = await pingGitHub(process.env.GITHUB_TOKEN);
      checks.push({
        label: "GITHUB_TOKEN set",
        ok: true,
        detail: `authenticated as ${login}`,
      });
    } catch (error) {
      checks.push({
        label: "GITHUB_TOKEN set",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (config) {
      const github = new GitHubClient({ token: process.env.GITHUB_TOKEN });
      for (const repo of config.repos) {
        try {
          await assertBaseBranchExists(github, repo.targetRepo, repo.baseBranch);
          checks.push({
            label: `${repo.id} base branch exists`,
            ok: true,
            detail: `${repo.targetRepo}#${repo.baseBranch}`,
          });
        } catch (error) {
          checks.push({
            label: `${repo.id} base branch exists`,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        try {
          await assertHeadBranchWritePermission(github, repo.targetRepo);
          checks.push({
            label: `${repo.id} PR head-branch write`,
            ok: true,
            detail: "token can update PR branches",
          });
        } catch (error) {
          checks.push({
            label: `${repo.id} PR head-branch write`,
            ok: false,
            detail:
              error instanceof Error
                ? error.message
                : "Grant classic repo scope, or fine-grained Contents: Read and write plus Pull requests: Read and write on the target repo.",
          });
        }
      }
    }
  } else {
    checks.push({
      label: "GITHUB_TOKEN set",
      ok: false,
      detail: "required for handoff runs (Milestone 4+)",
    });
  }

  for (const check of checks) {
    console.log(formatDoctorCheckLine(check));
  }

  return doctorChecksFailed(checks) ? EXIT_CONFIG : EXIT_SUCCESS;
}
