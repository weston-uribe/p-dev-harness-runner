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
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import {
  doctorChecksFailed,
  doctorChecksDegraded,
  formatDoctorCheckLine,
  sanitizeDoctorFailedChecks,
  summarizeDoctorChecksBySeverity,
  type DoctorCheckResult,
  type DoctorCheckSeverity,
} from "../../setup/doctor-summary.js";
import { createLiveGitHubRemoteSetupProvider } from "../../setup/github-remote-setup-live.js";
import { previewTargetWorkflowSetup } from "../../setup/target-workflow-setup.js";
import { workflowStatusNeedsUpgrade } from "../../setup/target-workflow-contract.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";

export type DoctorProfile = "full" | "merge" | "reconciler";

export interface DoctorOptions {
  configPath: string;
  profile?: DoctorProfile;
}

function reconcileHealthSeverity(
  profile: DoctorProfile,
): DoctorCheckSeverity {
  return profile === "reconciler" ? "critical" : "degraded";
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
      severity: "critical",
      classification: "invalid_harness_config",
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
        severity: "critical",
        classification: "linear_auth_failure",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      label: "LINEAR_API_KEY set",
      ok: false,
      severity: "critical",
      classification: "missing_linear_api_key",
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
  } else if (profile === "merge" || profile === "reconciler") {
    checks.push({
      label: "CURSOR_API_KEY set",
      ok: true,
      skipped: true,
      severity: "informational",
      detail:
        profile === "merge"
          ? "required only when merge integration repair needs a Cursor agent"
          : "not required for reconciler health profile",
    });
  } else {
    checks.push({
      label: "CURSOR_API_KEY set",
      ok: false,
      severity: "critical",
      classification: "missing_cursor_api_key",
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
        severity: "critical",
        classification: "github_auth_failure",
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
      severity: "critical",
      classification: "missing_github_token",
      detail: "required for handoff runs (Milestone 4+)",
    });
  }

  {
    const dispatchToken =
      process.env.GITHUB_DISPATCH_TOKEN?.trim() ||
      process.env.HARNESS_GITHUB_TOKEN?.trim();
    checks.push({
      label: "GITHUB_DISPATCH_TOKEN (or HARNESS_GITHUB_TOKEN) set",
      ok: Boolean(dispatchToken),
      severity: "critical",
      classification: dispatchToken
        ? "dispatch_token_present"
        : "missing_dispatch_token",
      detail: dispatchToken
        ? "dispatch token available for opaque repository_dispatch"
        : "required for Plan Review / Code Review / reconcile opaque dispatch",
    });
  }

  try {
    const { inspectReconcileWorkflowSource, RECONCILE_WORKFLOW_RELATIVE_PATH } =
      await import("../../workflow/reconcile-health.js");
    const { loadReconcileHeartbeat } = await import(
      "../../workflow/reconcile-heartbeat-store.js"
    );
    const { evaluateReconcileHeartbeatHealth } = await import(
      "../../workflow/reconcile-health.js"
    );
    const fs = await import("node:fs/promises");
    const workflowPath = path.join(
      process.cwd(),
      RECONCILE_WORKFLOW_RELATIVE_PATH,
    );
    let workflowContent = "";
    try {
      workflowContent = await fs.readFile(workflowPath, "utf8");
    } catch {
      workflowContent = "";
    }
    const workflowInspect = inspectReconcileWorkflowSource(workflowContent);
    const reconcileOk =
      Boolean(workflowContent) &&
      workflowInspect.hasSchedule &&
      workflowInspect.hasRequiredCron &&
      workflowInspect.invokesReconcileCommand;
    const reconcileSeverity = reconcileHealthSeverity(profile);
    checks.push({
      label: "Reconcile workflow present and scheduled",
      ok: reconcileOk,
      severity: reconcileOk ? "informational" : reconcileSeverity,
      classification: reconcileOk
        ? "reconcile_workflow_ok"
        : "reconcile_workflow_incomplete",
      detail: workflowContent
        ? workflowInspect.detail
        : `Missing ${RECONCILE_WORKFLOW_RELATIVE_PATH}`,
    });

    const heartbeat = await loadReconcileHeartbeat();
    const heartbeatHealth = evaluateReconcileHeartbeatHealth(heartbeat);
    const ageMinutes =
      heartbeatHealth.ageMs != null
        ? Math.round(heartbeatHealth.ageMs / 60000)
        : null;
    const heartbeatSkipped =
      !process.env.P_DEV_STATE_GITHUB_TOKEN && !heartbeat;
    const heartbeatSeverity = reconcileHealthSeverity(profile);
    const lastRunId =
      heartbeat?.lastWorkflowRunId ?? heartbeat?.workflowRunId ?? null;
    const recoveryHint =
      "Run npm run harness:reconcile-workflow (or dispatch Harness Reconcile Stranded Issues). Primary webhook phases continue when critical deps are healthy.";
    checks.push({
      label: "Reconcile heartbeat fresh",
      ok: heartbeatHealth.ok,
      skipped: heartbeatSkipped,
      severity: heartbeatSkipped
        ? "informational"
        : heartbeatHealth.ok
          ? "informational"
          : heartbeatSeverity,
      classification: heartbeatHealth.ok
        ? "reconcile_heartbeat_fresh"
        : heartbeatHealth.reason === "stale"
          ? "reconcile_heartbeat_stale"
          : heartbeatHealth.reason === "missing"
            ? "reconcile_heartbeat_missing"
            : "reconcile_heartbeat_invalid",
      detail: heartbeatHealth.ok
        ? `Heartbeat age ${ageMinutes}m; lastSuccessfulScanAt=${heartbeat?.lastSuccessfulScanAt ?? heartbeat?.finishedAt}; lastWorkflowRunId=${lastRunId ?? "?"}; dispatchEnabled=${heartbeat?.dispatchEnabled ?? "?"}; outcome=${heartbeat?.lastOutcome ?? heartbeat?.outcome ?? "success"}`
        : `${heartbeatHealth.detail}${lastRunId ? ` lastWorkflowRunId=${lastRunId}` : ""}${heartbeat?.lastFailure ? ` lastFailure=${heartbeat.lastFailure}` : ""}${heartbeat?.lastSuccessfulScanAt ? ` lastSuccessfulScanAt=${heartbeat.lastSuccessfulScanAt}` : ""}. ${recoveryHint}`,
    });
    if (config) {
      const { resolveAuthoritativeLinearTeamIdFromConfig, resolveAuthoritativeLinearTeamIds } =
        await import("../../config/resolve-linear-team.js");
      const { resolveLinearAssociationsFromConfig } = await import(
        "../../config/resolve-linear-workspace.js"
      );
      const associations = resolveLinearAssociationsFromConfig(config);
      const authoritative = resolveAuthoritativeLinearTeamIdFromConfig(config);
      const allTeams = resolveAuthoritativeLinearTeamIds(config);
      if (associations.length > 1 && authoritative) {
        const first = associations[0];
        checks.push({
          label: "Multi-team workflow-state association path",
          ok: true,
          severity: "informational",
          detail: `Writers use config-authoritative team path first (${authoritative}${first?.teamKey ? ` / ${first.teamKey}` : ""}). Issues on other configured teams (${allTeams.filter((t) => t !== authoritative).join(", ") || "none"}) reuse that path via candidate search; do not expect a per-issue-team duplicate record.`,
        });
      }
    }
  } catch (error) {
    checks.push({
      label: "Reconcile health checks",
      ok: false,
      severity: reconcileHealthSeverity(profile),
      classification: "reconcile_health_check_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (config) {
    const cwd = path.dirname(path.resolve(options.configPath));
    const dispatchRepo = await resolveHarnessDispatchRepo({ cwd });
    if (dispatchRepo.resolved && dispatchRepo.repo) {
      const token = process.env.GITHUB_TOKEN ?? process.env.HARNESS_GITHUB_TOKEN;
      const provider = token
        ? createLiveGitHubRemoteSetupProvider(token)
        : null;

      for (const repo of config.repos) {
        if (repo.baseBranch === repo.productionBranch) {
          continue;
        }
        const preview = previewTargetWorkflowSetup({
          repoConfigId: repo.id,
          targetRepo: repo.targetRepo,
          productionBranch: repo.productionBranch,
          harnessDispatchRepo: dispatchRepo,
        });
        let status = preview.plan.workflowStatus;
        if (provider && !preview.validationError) {
          try {
            const remote = await provider.checkTargetWorkflowStatus({
              targetRepoSlug: preview.plan.targetRepoSlug,
              productionBranch: repo.productionBranch,
              workflowPath: preview.plan.workflowPath,
              intendedWorkflowContent: preview.workflowContent,
            });
            status = remote.workflowStatus;
          } catch (error) {
            checks.push({
              label: `${repo.id} target workflow`,
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
        } else if (!provider) {
          status = "unknown";
        }

        const needsUpgrade = workflowStatusNeedsUpgrade(status);
        checks.push({
          label: `${repo.id} target workflow`,
          ok:
            status !== "stale_dispatch_target" &&
            status !== "missing" &&
            status !== "unknown",
          skipped: status === "unknown",
          detail:
            status === "unknown"
              ? "GITHUB_TOKEN required for live audit"
              : needsUpgrade
                ? `${status} — run harness:upgrade-target-workflows`
                : status,
        });
      }
    }
  }

  const tallies = summarizeDoctorChecksBySeverity(checks);
  const criticalFailed = doctorChecksFailed(checks);
  const degraded = doctorChecksDegraded(checks);
  const sanitizedFailures = sanitizeDoctorFailedChecks(checks);

  if (isPublicRunnerMode()) {
    new PublicSafeLogger().log({
      phase: "doctor",
      outcome: criticalFailed ? "failure" : "success",
      errorCode: criticalFailed
        ? "doctor_checks_failed"
        : degraded
          ? "doctor_degraded"
          : undefined,
      retryCount: tallies.passed,
      noops: tallies.skipped,
      blockers: tallies.critical,
      success: !criticalFailed,
    });
    if (sanitizedFailures.length > 0) {
      // Sanitized labels only — no secrets/details in public mode.
      console.log(
        JSON.stringify({
          phase: "doctor",
          publicEventType: "doctor_failed_checks",
          failedChecks: sanitizedFailures,
          degraded: tallies.degraded,
        }),
      );
    }
  } else {
    for (const check of checks) {
      console.log(formatDoctorCheckLine(check));
    }
    if (degraded && !criticalFailed) {
      console.log(
        `⚠ Doctor health degraded (${tallies.degraded} check(s)); phase execution not blocked.`,
      );
    }
  }

  return criticalFailed ? EXIT_CONFIG : EXIT_SUCCESS;
}
