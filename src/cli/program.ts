import { Command } from "commander";
import {
  DISPATCH_PHASE_CLI_DESCRIPTION,
  RUN_PHASE_CLI_DESCRIPTION,
} from "../runner/phase-args.js";
import { runDoctor } from "./commands/doctor.js";
import { runInspect } from "./commands/inspect.js";
import { runRunCommand } from "./commands/run.js";
import { runValidateIssue } from "./commands/validate-issue.js";
import { runSyncProductionCommand } from "./commands/sync-production.js";
import { runReconcileProductionCommand } from "./commands/reconcile-production.js";
import { runUpgradeTargetWorkflowsCommand } from "./commands/upgrade-target-workflows.js";
import { runResolveRouteCommand } from "./commands/resolve-route.js";
import { runReconcileRevisionCommand } from "./commands/reconcile-revision.js";
import { runReconcileMergeCommand } from "./commands/reconcile-merge.js";
import { runReconcileWorkflowCommand } from "./commands/reconcile-workflow.js";
import { runClaimJobRequestCommand } from "./commands/claim-job-request.js";
import { runFailJobRequestCommand } from "./commands/fail-job-request.js";
import { runDispatchJobRequestCommand } from "./commands/dispatch-job-request.js";
import { runPrivateStateCanaryCommand } from "./commands/private-state-canary.js";
import { runWorkflowStatusReportCommand } from "./commands/workflow-status-report.js";
import { runWorkflowStatusMigrateCommand } from "./commands/workflow-status-migrate.js";
import { runValidationRunCommand } from "./commands/validation-run.js";
import { runRedactOutputCommand } from "./commands/redact-output.js";
import { runDiagnoseVercelBridgeCommand } from "./commands/diagnose-vercel-bridge.js";
import { runOperatorInit } from "./commands/operator-init.js";
import { runCanaryRunnerConfigCommand } from "./commands/canary-runner-config.js";
import { runSyncManagedRunnerCommand } from "./commands/sync-managed-runner.js";
import {
  runEvalAnnotate,
  runEvalAnnotationBundle,
  runEvalAnnotationCoverage,
  runEvalAnnotationExport,
  runEvalAnnotationValidate,
  runEvalDatasetReadiness,
  runEvalEvaluate,
  runEvalEvaluatorPlan,
  runEvalEvaluatorSummary,
  runEvalEvaluatorValidate,
  runEvalEvaluatorsList,
  runEvalSubjects,
  runEvalSubjectsList,
} from "./commands/eval.js";
import { runEvaluationCanaryLangfuseProjection } from "./commands/evaluation-canary-langfuse-projection.js";
import { runEvaluationInspectLangfuse } from "./commands/evaluation-inspect-langfuse.js";
import { runEvaluationReprojectLangfuse } from "./commands/evaluation-reproject-langfuse.js";
import { runPromptsValidate } from "./commands/prompts-validate.js";
import { runPromptsLangfuseSync } from "./commands/prompts-langfuse-sync.js";
import { runEvaluationCanaryNativeSkill } from "./commands/evaluation-canary-native-skill.js";
import { runEvaluationProbeCursorSdkUsage } from "./commands/evaluation-probe-cursor-sdk-usage.js";
import { runEvaluationImportCursorUsage } from "./commands/evaluation-import-cursor-usage.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("harness")
    .description("Agentic product development harness runner")
    .option(
      "--config <path>",
      "Path to harness.config.json (explicit flag overrides HARNESS_CONFIG_* env)",
      "harness.config.json",
    );

  program
    .command("doctor")
    .description("Validate config, allowlist, and optional Linear auth")
    .option(
      "--profile <profile>",
      "Validation profile: full (default phase), merge (GitHub/Linear), or reconciler (strict heartbeat/schedule health)",
      "full",
    )
    .action(async (options: { profile?: string }) => {
      const configPath = program.opts<{ config: string }>().config;
      const raw = options.profile?.trim().toLowerCase();
      const profile =
        raw === "merge" || raw === "reconciler" ? raw : "full";
      const exitCode = await runDoctor({ configPath, profile });
      process.exitCode = exitCode;
    });

  program
    .command("run")
    .description("Run harness against a Linear issue")
    .option("--issue <key>", "Linear issue key, e.g. WES-11")
    .option("--request-id <id>", "Opaque job request id from private envelope")
    .option("--dry-run", "Parse and resolve without side effects", false)
    .option(
      "--phase <phase>",
      `Run phase: ${RUN_PHASE_CLI_DESCRIPTION} (default: auto for live runs)`,
      "auto",
    )
    .option("--force", "Re-run planning even when idempotency markers exist", false)
    .option("--fixture <path>", "Load issue description from a local markdown fixture")
    .option("--json", "Print manifest JSON to stdout", false)
    .option("--json-out <path>", "Write redacted manifest JSON to a file")
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runRunCommand({
        issueKey: opts.issue,
        requestId: opts.requestId,
        configPath,
        dryRun: opts.dryRun,
        fixturePath: opts.fixture,
        json: opts.json,
        jsonOut: opts.jsonOut,
        phase: opts.phase,
        force: opts.force,
      });
      process.exitCode = exitCode;
    });

  program
    .command("inspect")
    .description("Inspect a prior harness run directory")
    .requiredOption("--run <path>", "Path to run directory under runs/")
    .action(async (opts) => {
      const exitCode = await runInspect({ runPath: opts.run });
      process.exitCode = exitCode;
    });

  program
    .command("validate-issue")
    .description("Validate a Linear issue description without side effects")
    .option("--file <path>", "Path to issue markdown file")
    .option("--issue <key>", "Linear issue key, e.g. WES-11")
    .option(
      "--intended-phase <phase>",
      "Route-specific validation: planning or implementation",
    )
    .option("--json", "Print validation result JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runValidateIssue({
        configPath,
        filePath: opts.file,
        issueKey: opts.issue,
        intendedPhase: opts.intendedPhase,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("resolve-route")
    .description("Resolve harness phase and target repo for workflow routing")
    .option("--issue <key>", "Linear issue key, e.g. WES-11")
    .option("--request-id <id>", "Opaque job request id from private envelope")
    .option(
      "--phase <phase>",
      `Phase override: ${DISPATCH_PHASE_CLI_DESCRIPTION}`,
      "auto",
    )
    .option("--json", "Print route JSON to stdout", false)
    .option(
      "--github-output",
      "Append route fields to GITHUB_OUTPUT for Actions",
      false,
    )
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runResolveRouteCommand({
        issueKey: opts.issue,
        requestId: opts.requestId,
        configPath,
        phase: opts.phase,
        json: opts.json,
        githubOutput: opts.githubOutput,
      });
      process.exitCode = exitCode;
    });

  program
    .command("claim-job-request")
    .description("Claim a private job-request envelope and expose issue key to GITHUB_ENV")
    .requiredOption("--request-id <id>", "Opaque job request id")
    .option("--json", "Print public-safe claim JSON to stdout", false)
    .action(async (opts) => {
      const exitCode = await runClaimJobRequestCommand({
        requestId: opts.requestId,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("fail-job-request")
    .description(
      "Mark a claimed private job-request envelope as failed (operator recovery)",
    )
    .requiredOption("--request-id <id>", "Opaque job request id")
    .requiredOption(
      "--completion-state <state>",
      "Durable completion state recorded on the envelope",
    )
    .option("--json", "Print public-safe result JSON to stdout", false)
    .action(async (opts) => {
      const exitCode = await runFailJobRequestCommand({
        requestId: opts.requestId,
        completionState: opts.completionState,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("dispatch-job-request")
    .description(
      "Operator-local: create a private job-request envelope and dispatch an opaque request id",
    )
    .requiredOption("--issue <issueKey>", "Linear issue key (private; never sent as public input)")
    .option("--phase <phase>", "Requested phase or auto", "auto")
    .option("--force", "Force recovery mode on the envelope", false)
    .option("--json", "Print operator result JSON (includes private issue key)", false)
    .action(async (opts) => {
      const exitCode = await runDispatchJobRequestCommand({
        issue: opts.issue,
        phase: opts.phase,
        force: opts.force,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("private-state-canary")
    .description("CAS read/write canary against managed private workflow state")
    .option("--json", "Print public-safe canary JSON to stdout", false)
    .action(async (opts) => {
      const exitCode = await runPrivateStateCanaryCommand({ json: opts.json });
      process.exitCode = exitCode;
    });

  program
    .command("sync-production")
    .description("Sync Linear issues from Merged to Dev to Merged / Deployed when promoted")
    .option("--repo <id>", "Repo config id, e.g. target-app")
    .option("--issue <key>", "Single Linear issue key, e.g. WES-11")
    .option(
      "--source-repo <slug>",
      "Dispatch sourceRepo slug, e.g. owner/example-target-app",
    )
    .option(
      "--production-branch <branch>",
      "Dispatch productionBranch, e.g. main",
    )
    .option("--ref <ref>", "Dispatch git ref, e.g. refs/heads/main")
    .option("--dry-run", "Inspect without Linear writes", false)
    .option("--force", "Re-run even when markers exist", false)
    .option("--json", "Print sync summary JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runSyncProductionCommand({
        configPath,
        repo: opts.repo,
        issue: opts.issue,
        sourceRepo: opts.sourceRepo,
        productionBranch: opts.productionBranch,
        ref: opts.ref,
        dryRun: opts.dryRun,
        force: opts.force,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("reconcile-production")
    .description(
      "Reconcile production delivery for all (or one) configured target repos",
    )
    .option("--repo <id>", "Optional repo config id to scope reconcile")
    .option("--dry-run", "Inspect without Linear / Langfuse writes", false)
    .option("--json", "Print reconcile summary JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runReconcileProductionCommand({
        configPath,
        repo: opts.repo,
        dryRun: opts.dryRun,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("upgrade-target-workflows")
    .description(
      "Audit and upgrade managed target-repo production-sync workflows (contract v2)",
    )
    .option("--repo <id>", "Optional repo config id to scope audit/upgrade")
    .option("--dry-run", "Audit only; do not open upgrade PRs", false)
    .option("--json", "Print audit JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runUpgradeTargetWorkflowsCommand({
        configPath,
        repo: opts.repo,
        dryRun: opts.dryRun,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("canary-runner-config")
    .description("Validate managed runner marker and cloud config fingerprint pairing")
    .action(async () => {
      const exitCode = await runCanaryRunnerConfigCommand();
      process.exitCode = exitCode;
    });

  program
    .command("sync-managed-runner")
    .description(
      "Release unblocker: sync one known managed harness runner, cloud config, and config canary",
    )
    .option(
      "--p-dev-home <path>",
      "Operator workspace (P_DEV_HOME) containing .env.local and .harness/",
    )
    .option(
      "--apply",
      "Perform remote sync (default is dry-run verification only)",
      false,
    )
    .option(
      "--keep-pending",
      "Do not archive/clear an existing local runner-upgrade pending file",
      false,
    )
    .option("--json", "Print JSON result to stdout", false)
    .action(async (opts: {
      pDevHome?: string;
      apply?: boolean;
      keepPending?: boolean;
      json?: boolean;
    }) => {
      const exitCode = await runSyncManagedRunnerCommand({
        pDevHome: opts.pDevHome,
        apply: opts.apply === true,
        cancelPending: opts.keepPending !== true,
        json: opts.json === true,
      });
      process.exitCode = exitCode;
    });

  program
    .command("redact-output")
    .description("Read stdin and write redacted JSON or text to stdout")
    .action(async () => {
      const exitCode = await runRedactOutputCommand();
      process.exitCode = exitCode;
    });

  program
    .command("diagnose-vercel-bridge")
    .description(
      "Print a redacted JSON diagnostic report for Configure Step 3 Vercel bridge verification",
    )
    .option(
      "--live-probe",
      "Send a fresh signed webhook probe (default is read-only diagnostics only)",
      false,
    )
    .action(async (opts: { liveProbe?: boolean }) => {
      const exitCode = await runDiagnoseVercelBridgeCommand({
        liveProbe: opts.liveProbe === true,
      });
      process.exitCode = exitCode;
    });

  program
    .command("reconcile-revision")
    .description(
      "Evaluate revision eligibility from Linear state; optionally dispatch or record pending intent",
    )
    .option(
      "--issue <key>",
      "Linear issue key (optional in public mode when private runtime context exists)",
    )
    .option("--json", "Print reconcile JSON to stdout", false)
    .option("--dry-run", "Evaluate only; no Linear writes or dispatch", false)
    .option(
      "--dispatch",
      "When eligible, send repository_dispatch for a revision run",
      false,
    )
    .option("--force", "Force revision even when a matching marker exists", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runReconcileRevisionCommand({
        issueKey: opts.issue,
        configPath,
        json: opts.json,
        dryRun: opts.dryRun,
        dispatch: opts.dispatch,
        force: opts.force,
      });
      process.exitCode = exitCode;
    });

  program
    .command("reconcile-merge")
    .description(
      "Evaluate merge eligibility from Linear/GitHub state; optionally dispatch a merge run",
    )
    .requiredOption("--issue <key>", "Linear issue key, e.g. FRE-3")
    .option("--json", "Print reconcile JSON to stdout", false)
    .option("--dry-run", "Evaluate only; no dispatch", false)
    .option(
      "--dispatch",
      "When eligible, send repository_dispatch for a merge run",
      false,
    )
    .option("--force", "Force merge reconcile while status is Merging", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runReconcileMergeCommand({
        issueKey: opts.issue,
        configPath,
        json: opts.json,
        dryRun: opts.dryRun,
        dispatch: opts.dispatch,
        force: opts.force,
      });
      process.exitCode = exitCode;
    });

  program
    .command("reconcile-workflow")
    .description(
      "Scan configured Linear teams for stranded workflow issues; optionally dispatch recovery runs",
    )
    .option("--issue <key>", "Reconcile a single Linear issue key")
    .option(
      "--phase <phase>",
      "Pin inspection/recovery to one phase (plan_review, implementation, code_review); never reinterpret current Linear status as another phase",
    )
    .option(
      "--subject <identity>",
      "Pin inspection/recovery to one durable subject identity",
    )
    .option(
      "--request-id <id>",
      "Inspect one job-request envelope only (no phase reinterpretation)",
    )
    .option("--json", "Print reconcile JSON to stdout", false)
    .option("--dry-run", "Evaluate only; no Linear writes or dispatch", false)
    .option(
      "--dispatch",
      "When eligible, send repository_dispatch for recovery runs",
      false,
    )
    .option("--force", "Force reconcile while transitional statuses allow", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runReconcileWorkflowCommand({
        issueKey: opts.issue,
        configPath,
        json: opts.json,
        dryRun: opts.dryRun,
        dispatch: opts.dispatch,
        force: opts.force,
        phase: opts.phase,
        subject: opts.subject,
        requestId: opts.requestId,
      });
      process.exitCode = exitCode;
    });

  program
    .command("workflow-status-report")
    .description(
      "Dry-run Linear workflow status requirement report (no status mutations)",
    )
    .option("--team-id <id>", "Linear team id to inspect")
    .option(
      "--output <path>",
      "Write JSON report path (default: runs/workflow-status-requirement-report.json)",
    )
    .option("--json", "Print report JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      const exitCode = await runWorkflowStatusReportCommand({
        configPath,
        teamId: opts.teamId,
        outputPath: opts.output,
        json: opts.json,
      });
      process.exitCode = exitCode;
    });

  program
    .command("workflow-status-migrate")
    .description(
      "Create-only migration for Plan Review / Code Review / Code Revision Linear statuses",
    )
    .option("--team-id <id>", "Linear team id")
    .option("--apply", "Create missing statuses (default dry-run)", false)
    .option("--output <path>", "Write JSON migration artifact")
    .option("--json", "Print JSON to stdout", false)
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runWorkflowStatusMigrateCommand({
        configPath,
        teamId: opts.teamId,
        apply: opts.apply === true,
        outputPath: opts.output,
        json: opts.json === true,
      });
    });

  const validationRun = program
    .command("validation-run")
    .description(
      "Issue-scoped validation-run overrides for optional review phases (never toggles shared defaults)",
    );

  validationRun
    .command("create")
    .description("Create an active validation-run snapshot for allowlisted issues")
    .requiredOption(
      "--issue <issueKey>",
      "Allowlisted issue key (repeatable)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option("--plan-review", "Request Plan Review for allowlisted issues", false)
    .option("--code-review", "Request Code Review for allowlisted issues", false)
    .option("--team-id <id>", "Linear team id")
    .option("--project-id <id>", "Linear project id")
    .option("--expires-at <iso>", "Optional expiration timestamp")
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "create",
        issueIds: opts.issue,
        planReview: opts.planReview === true,
        codeReview: opts.codeReview === true,
        teamId: opts.teamId,
        projectId: opts.projectId,
        expiresAt: opts.expiresAt,
      });
    });

  validationRun
    .command("list")
    .description("List validation-run snapshots")
    .action(async () => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "list",
      });
    });

  validationRun
    .command("complete")
    .description("Mark a validation run completed")
    .requiredOption("--id <validationRunId>", "Validation run id")
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "complete",
        validationRunId: opts.id,
      });
    });

  validationRun
    .command("expire")
    .description("Mark a validation run expired")
    .requiredOption("--id <validationRunId>", "Validation run id")
    .action(async (opts) => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "expire",
        validationRunId: opts.id,
      });
    });

  validationRun
    .command("cleanup-report")
    .description("Report active/expired/completed validation runs (exit 1 if any active)")
    .action(async () => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "cleanup-report",
      });
    });

  validationRun
    .command("complete-all")
    .description("Complete all active validation runs and print cleanup report")
    .action(async () => {
      const configPath = program.opts<{ config: string }>().config;
      process.exitCode = await runValidationRunCommand({
        configPath,
        action: "complete-all",
      });
    });

  const operator = program
    .command("operator")
    .description("Operator setup helpers");

  operator
    .command("init")
    .description("Create local .env.local and .harness/config.local.json from examples")
    .option("--force", "Overwrite existing local files", false)
    .action(async (opts: { force?: boolean }) => {
      const exitCode = await runOperatorInit({ force: opts.force ?? false });
      process.exitCode = exitCode;
    });

  const evalCmd = program
    .command("eval")
    .description(
      "Offline evaluation subjects, rubrics, human annotations, and deterministic evaluators",
    );

  evalCmd
    .command("subjects")
    .description("Extract evaluation subjects from local run evidence")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--run <path>", "Limit extraction to one run directory")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        run?: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalSubjects({
          configPath,
          issueKey: opts.issue,
          runDirectory: opts.run,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("subjects-list")
    .description("List annotation-eligible evaluation subjects")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalSubjectsList({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("annotation-bundle")
    .description("Generate a disposable human annotation review bundle")
    .requiredOption("--issue <key>", "Linear issue key")
    .requiredOption("--subject <id>", "evaluationSubjectId")
    .option("--run <path>", "Run directory for optional evidence previews")
    .option("--include-previews", "Include bounded evidence previews", false)
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        subject: string;
        run?: string;
        includePreviews?: boolean;
        logDirectory?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalAnnotationBundle({
          configPath,
          issueKey: opts.issue,
          subjectId: opts.subject,
          runDirectory: opts.run,
          includePreviews: opts.includePreviews === true,
          logDirectory: opts.logDirectory,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("annotate")
    .description("Append a human annotation from a JSON input file")
    .requiredOption("--issue <key>", "Linear issue key")
    .requiredOption("--input <path>", "Annotation input JSON file")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        input: string;
        logDirectory?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalAnnotate({
          configPath,
          issueKey: opts.issue,
          inputPath: opts.input,
          logDirectory: opts.logDirectory,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("annotation-validate")
    .description("Validate the local annotations store")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalAnnotationValidate({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("annotation-coverage")
    .description("Compute annotation coverage artifact")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalAnnotationCoverage({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("dataset-readiness")
    .description("Derive dataset-readiness.json from subjects and annotations")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalDatasetReadiness({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("annotation-export")
    .description("Export submitted annotations for later Langfuse import")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--output <path>", "Output JSON path")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        output?: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalAnnotationExport({
          configPath,
          issueKey: opts.issue,
          outputPath: opts.output,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("evaluators-list")
    .description("List registered deterministic evaluators")
    .option("--json", "Print JSON", false)
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await runEvalEvaluatorsList({
        json: opts.json === true,
      });
    });

  evalCmd
    .command("evaluator-plan")
    .description("Dry-run plan of applicable deterministic evaluators")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--subject <id>", "Limit to evaluationSubjectId")
    .option("--subject-type <type>", "Limit to subject type")
    .option("--phase <phase>", "Limit to phase")
    .option("--evaluator <id>", "Limit to evaluatorId")
    .option("--rubric <id>", "Limit to rubricId")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        subject?: string;
        subjectType?: string;
        phase?: string;
        evaluator?: string;
        rubric?: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalEvaluatorPlan({
          configPath,
          issueKey: opts.issue,
          subjectId: opts.subject,
          subjectType: opts.subjectType,
          phase: opts.phase,
          evaluatorId: opts.evaluator,
          rubricId: opts.rubric,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("evaluate")
    .description("Run deterministic evaluators and append immutable results")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--subject <id>", "Limit to evaluationSubjectId")
    .option("--subject-type <type>", "Limit to subject type")
    .option("--phase <phase>", "Limit to phase")
    .option("--evaluator <id>", "Limit to evaluatorId")
    .option("--rubric <id>", "Limit to rubricId")
    .option("--dry-run", "Plan only; do not write results", false)
    .option(
      "--force",
      "Re-execute even when identical result ID exists (no duplicate append)",
      false,
    )
    .option("--concurrency <n>", "Max concurrent evaluators", "1")
    .option(
      "--fail-on-evaluator-error",
      "Exit non-zero when any evaluator status is error",
      false,
    )
    .option(
      "--fail-on-contract-failure",
      "Exit non-zero when any evaluator status is fail",
      false,
    )
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        subject?: string;
        subjectType?: string;
        phase?: string;
        evaluator?: string;
        rubric?: string;
        dryRun?: boolean;
        force?: boolean;
        concurrency?: string;
        failOnEvaluatorError?: boolean;
        failOnContractFailure?: boolean;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalEvaluate({
          configPath,
          issueKey: opts.issue,
          subjectId: opts.subject,
          subjectType: opts.subjectType,
          phase: opts.phase,
          evaluatorId: opts.evaluator,
          rubricId: opts.rubric,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
          concurrency: Number.parseInt(opts.concurrency ?? "1", 10) || 1,
          failOnEvaluatorError: opts.failOnEvaluatorError === true,
          failOnContractFailure: opts.failOnContractFailure === true,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("evaluator-validate")
    .description("Validate the local evaluator-results store")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalEvaluatorValidate({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("evaluator-summary")
    .description("Regenerate derived evaluator-summary.json")
    .requiredOption("--issue <key>", "Linear issue key")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--json", "Print JSON", false)
    .action(
      async (opts: {
        issue: string;
        logDirectory?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvalEvaluatorSummary({
          configPath,
          issueKey: opts.issue,
          logDirectory: opts.logDirectory,
          namespace: opts.namespace,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("inspect-langfuse")
    .description(
      "Maintainer-only: inventory a Langfuse issue session and emit a redacted gap report",
    )
    .option(
      "--issue <key>",
      "Linear issue key (optional in public mode when private runtime context exists)",
    )
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option(
      "--out <path>",
      "Write report JSON (private full report locally; public-safe summary in public runner mode)",
    )
    .option(
      "--safe-content",
      "Include content hashes/byte counts on private reports (never raw bodies)",
      false,
    )
    .option(
      "--expected-phases <phases>",
      "Comma-separated expected agent phases (default: planning,plan_review)",
    )
    .option("--json", "Print full private report JSON to stdout (private mode)", false)
    .action(
      async (opts: {
        issue?: string;
        namespace?: string;
        logDirectory?: string;
        out?: string;
        safeContent?: boolean;
        expectedPhases?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvaluationInspectLangfuse({
          issueKey: opts.issue,
          configPath,
          namespace: opts.namespace,
          logDirectory: opts.logDirectory,
          out: opts.out,
          safeContent: opts.safeContent === true,
          expectedPhases: opts.expectedPhases,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("reproject-langfuse")
    .description(
      "Maintainer-only: idempotently reproject issue artifacts into Langfuse",
    )
    .option(
      "--issue <key>",
      "Linear issue key (optional in public mode when private runtime context exists)",
    )
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option(
      "--artifact-cache <path>",
      "Directory containing downloaded run artifacts",
    )
    .option("--dry-run", "Plan changes without writing to Langfuse", true)
    .option("--apply", "Apply reprojection to Langfuse", false)
    .option("--out <path>", "Write redacted change report JSON")
    .option("--json", "Print report JSON to stdout", false)
    .action(
      async (opts: {
        issue?: string;
        namespace?: string;
        logDirectory?: string;
        artifactCache?: string;
        dryRun?: boolean;
        apply?: boolean;
        out?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvaluationReprojectLangfuse({
          issueKey: opts.issue,
          configPath,
          namespace: opts.namespace,
          logDirectory: opts.logDirectory,
          artifactCache: opts.artifactCache,
          dryRun: opts.apply === true ? false : opts.dryRun !== false,
          apply: opts.apply === true,
          out: opts.out,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("canary-langfuse-projection")
    .description(
      "Maintainer-only: emit a disposable synthetic Langfuse Complete Session projection",
    )
    .option("--issue <key>", "Synthetic issue key (default: auto-generated SYN-*)")
    .option("--namespace <namespace>", "Evaluation namespace")
    .option("--log-directory <path>", "Override harness logDirectory")
    .option("--apply", "Write the synthetic session to Langfuse", false)
    .option("--out <path>", "Write canary report JSON")
    .option("--json", "Print report JSON to stdout", false)
    .action(
      async (opts: {
        issue?: string;
        namespace?: string;
        logDirectory?: string;
        apply?: boolean;
        out?: string;
        json?: boolean;
      }) => {
        const configPath = program.opts<{ config: string }>().config;
        process.exitCode = await runEvaluationCanaryLangfuseProjection({
          issueKey: opts.issue,
          configPath,
          namespace: opts.namespace,
          logDirectory: opts.logDirectory,
          apply: opts.apply === true,
          out: opts.out,
          json: opts.json === true,
        });
      },
    );

  evalCmd
    .command("canary-native-skill")
    .description(
      "Native-skill canary: dry-run fixture prep, or --live Cloud Agent evidence collection",
    )
    .option("--live", "Run live Cloud Agent canary (requires API key + target repo)", false)
    .option("--target-repo <url>", "Disposable GitHub repo URL for live canary")
    .option("--keep-fixture", "Retain disposable fixture directory", false)
    .option("--out <path>", "Write report JSON")
    .option("--json", "Print report JSON to stdout", true)
    .action(
      async (opts: {
        live?: boolean;
        keepFixture?: boolean;
        out?: string;
        json?: boolean;
        targetRepo?: string;
      }) => {
        process.exitCode = await runEvaluationCanaryNativeSkill({
          live: opts.live === true,
          keepFixture: opts.keepFixture === true,
          out: opts.out,
          json: opts.json !== false,
          targetRepo: opts.targetRepo,
        });
      },
    );

  evalCmd
    .command("import-cursor-usage")
    .description(
      "Operator CSV import: scores-only Cursor usage + cost proxies on phase traces (no observation mutation)",
    )
    .requiredOption("--csv <path>", "Path to official Cursor usage CSV")
    .requiredOption(
      "--inspect-report <path>",
      "Path to private Langfuse inspect report JSON",
    )
    .requiredOption("--issue <key>", "Linear issue key (e.g. TT-14)")
    .option("--namespace <ns>", "Langfuse namespace")
    .option(
      "--phases <list>",
      "Comma-separated phases to attach (default: planning,plan_review)",
      "planning,plan_review",
    )
    .option("--dry-run", "Compute join/proxies without Langfuse writes", false)
    .option("--out <path>", "Write private import report JSON")
    .option("--public-out <path>", "Write public-safe summary JSON")
    .option("--json", "Print public summary JSON to stdout", true)
    .option(
      "--skip-second-import-verify",
      "Skip second-import idempotency check",
      false,
    )
    .action(
      async (opts: {
        csv: string;
        inspectReport: string;
        issue: string;
        namespace?: string;
        phases?: string;
        dryRun?: boolean;
        out?: string;
        publicOut?: string;
        json?: boolean;
        skipSecondImportVerify?: boolean;
      }) => {
        process.exitCode = await runEvaluationImportCursorUsage({
          csv: opts.csv,
          inspectReport: opts.inspectReport,
          issueKey: opts.issue,
          namespace: opts.namespace,
          phases: opts.phases,
          dryRun: opts.dryRun === true,
          out: opts.out,
          publicOut: opts.publicOut,
          json: opts.json !== false,
          skipSecondImportVerify: opts.skipSecondImportVerify === true,
        });
      },
    );

  evalCmd
    .command("probe-cursor-sdk-usage")
    .description(
      "Bounded maintainer probe: Cursor SDK usage surfaces (private report; public-safe summary)",
    )
    .option(
      "--target-repo <url>",
      "Cloud target repo URL (or P_DEV_CURSOR_SDK_USAGE_PROBE_REPO)",
    )
    .option("--starting-ref <ref>", "Cloud starting ref", "main")
    .option("--include-local", "Also run a local runtime probe for shape comparison", false)
    .option("--out <path>", "Write private report JSON")
    .option("--public-out <path>", "Write public-safe summary JSON")
    .option("--public-only", "Print only public-safe summary to stdout", false)
    .option("--json", "Print JSON to stdout", true)
    .action(
      async (opts: {
        targetRepo?: string;
        startingRef?: string;
        includeLocal?: boolean;
        out?: string;
        publicOut?: string;
        publicOnly?: boolean;
        json?: boolean;
      }) => {
        process.exitCode = await runEvaluationProbeCursorSdkUsage({
          targetRepo: opts.targetRepo,
          startingRef: opts.startingRef,
          includeLocal: opts.includeLocal === true,
          out: opts.out,
          publicOut: opts.publicOut,
          publicOnly: opts.publicOnly === true,
          json: opts.json !== false,
        });
      },
    );

  program
    .command("prompts:validate")
    .description(
      "Validate local prompt contracts and canonical .agents/skills packages",
    )
    .action(async () => {
      process.exitCode = await runPromptsValidate();
    });

  program
    .command("prompts:langfuse:sync")
    .description(
      "Prepare Langfuse prompt sync changeset; optionally publish immutable versions",
    )
    .option("--dry-run", "Prepare changeset without publishing (default)", true)
    .option("--label <label>", "Approved label (default: dogfood)", "dogfood")
    .option(
      "--publish",
      "Publish immutable prompt versions with the approved label (never latest)",
      false,
    )
    .action(
      async (opts: { dryRun?: boolean; label?: string; publish?: boolean }) => {
        process.exitCode = await runPromptsLangfuseSync({
          dryRun: opts.dryRun !== false,
          label: opts.label,
          publish: opts.publish === true,
        });
      },
    );

  return program;
}
