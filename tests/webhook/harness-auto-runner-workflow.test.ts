import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveWorkflowPath = path.join(repoRoot, ".github/workflows/harness-auto-runner.yml");
const fixtureWorkflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflows/harness-auto-runner-with-production-sync.yml",
);
const workflowsDir = path.join(repoRoot, ".github/workflows");

const MODE_ENV = "P_DEV_CURSOR_PROVENANCE_MODE";
const KEY_ENV = "P_DEV_PROVENANCE_KEY_V1";
const OBSOLETE_MODE_ENV = "P_DEV_PROVENANCE_MODE";
const MODE_FROM_VARS = `\${{ vars.${MODE_ENV} }}`;
const KEY_FROM_SECRETS = `\${{ secrets.${KEY_ENV} }}`;

type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};

type WorkflowDoc = {
  jobs?: Record<string, WorkflowJob>;
};

/** Quote unquoted single-line GitHub Actions `${{ }}` expressions for yaml@2. */
function quoteActionsExpressions(raw: string): string {
  return raw.replace(
    /^([ \t]*[A-Za-z0-9_.-]+:[ \t]*)(\$\{\{[^\n]+?\}\})[ \t]*$/gm,
    '$1"$2"',
  );
}

function loadWorkflowDoc(filePath: string): WorkflowDoc {
  return parseYaml(quoteActionsExpressions(readFileSync(filePath, "utf8"))) as WorkflowDoc;
}

function stepByName(job: WorkflowJob, name: string): WorkflowStep {
  const step = (job.steps ?? []).find((s) => s.name === name);
  if (!step) {
    throw new Error(`Step ${name} not found`);
  }
  return step;
}

function assertCursorProvenanceStepEnv(step: WorkflowStep, label: string): void {
  expect(step.env, `${label} must have step env`).toBeDefined();
  expect(step.env?.[MODE_ENV], `${label} mode`).toBe(MODE_FROM_VARS);
  expect(step.env?.[KEY_ENV], `${label} key`).toBe(KEY_FROM_SECRETS);
  expect(step.env?.[MODE_ENV]).not.toMatch(/shadow|required/i);
  expect(step.env?.[KEY_ENV]).not.toMatch(/^[0-9a-fA-F]{64}$/);
}

function extractJobSection(workflow: string, jobName: string): string {
  const marker = `${jobName}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Job ${jobName} not found`);
  }
  const rest = workflow.slice(start + marker.length);
  const nextJob = rest.search(/\n  [a-z][a-z0-9-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function assertHarnessWorkflowContracts(workflow: string, label: string): void {
  describe(`${label} workflow contract`, () => {
    it("subscribes to production_promoted repository_dispatch", () => {
      expect(workflow).toContain("production_promoted");
      expect(workflow).toContain("linear_issue_status_changed");
    });

    it("uses request_id workflow_dispatch input and client_payload.requestId", () => {
      expect(workflow).toContain("request_id:");
      expect(workflow).toContain("client_payload.requestId");
      expect(workflow).not.toMatch(/^\s+issue:\s*$/m);
    });

    it("defines gate job with claim, resolve-route, and without required concurrency", () => {
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toContain("harness:claim-job-request");
      expect(gate).toContain("harness:resolve-route");
      expect(gate).toContain("--request-id");
      expect(gate).not.toMatch(/^\s+concurrency:/m);
      expect(gate).toContain("GITHUB_TOKEN");
      expect(gate).not.toContain("issue_key:");
    });

    it("run-harness keeps per-request concurrency without canceling in-progress work", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      expect(runHarness).toContain(
        "harness-req-${{ needs.gate.outputs.request_id }}",
      );
      expect(runHarness).toContain("cancel-in-progress: false");
      expect(runHarness).not.toContain("harness-merge-");
    });

    it("Doctor-running jobs share GITHUB_DISPATCH_* env parity with run-harness", () => {
      const requiredDispatchEnv = [
        "GITHUB_DISPATCH_TOKEN: ${{ secrets.HARNESS_GITHUB_TOKEN }}",
        "GITHUB_DISPATCH_REPOSITORY: ${{ github.repository }}",
      ];
      const doctorJobs = [
        { name: "run-harness", profile: "harness:doctor" },
        { name: "run-merge", profile: "harness:doctor -- --profile merge" },
      ] as const;
      for (const job of doctorJobs) {
        const section = extractJobSection(workflow, job.name);
        for (const envLine of requiredDispatchEnv) {
          expect(section).toContain(envLine);
        }
        expect(section).toContain(job.profile);
      }
      const gate = extractJobSection(workflow, "gate");
      const syncSection = extractJobSection(workflow, "sync-production");
      for (const section of [gate, syncSection]) {
        expect(section).not.toContain(
          "GITHUB_DISPATCH_TOKEN: ${{ secrets.HARNESS_GITHUB_TOKEN }}",
        );
      }
    });

    it("finalize passes request id so pre-phase failures can terminalize the job request", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      for (const section of [runHarness, runMerge]) {
        expect(section).toContain("finalize-harness-run.ts");
        expect(section).toMatch(
          /finalize-harness-run\.ts[\s\S]*--request-id "\$REQUEST_ID"/,
        );
        expect(section).toContain("id: doctor");
        expect(section).toContain("Finalize pre-phase doctor failure");
        expect(section).toContain("--completion-state doctor_checks_failed");
        expect(section).toContain("harness:fail-job-request");
      }
    });

    it("run-merge uses repo/base merge concurrency with queued pending runs", () => {
      const runMerge = extractJobSection(workflow, "run-merge");
      expect(runMerge).toContain("harness-merge-${{ needs.gate.outputs.merge_concurrency_group }}");
      expect(runMerge).toContain("cancel-in-progress: false");
      expect(runMerge).toContain("queue: max");
      expect(runMerge).toContain("harness:run");
      expect(runMerge).toContain("--phase merge");
      expect(runMerge).toContain("harness:doctor -- --profile merge");
      expect(runMerge).toContain("CURSOR_API_KEY");
    });

    it("does not treat gate concurrency as sole duplicate protection", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      expect(gate).not.toMatch(/^\s+concurrency:/m);
      expect(runHarness).toMatch(/^\s+concurrency:/m);
    });

    it("defines sync-production job gated on production_promoted", () => {
      expect(workflow).toContain("sync-production:");
      expect(workflow).toContain("github.event.action == 'production_promoted'");
      expect(workflow).toContain("sync-production");
      expect(workflow).toContain("--json-out");
    });

    it("uses shared global production-sync concurrency without cancel", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("group: harness-production-sync");
      expect(syncSection).toContain("cancel-in-progress: false");
      expect(syncSection).not.toContain("cancel-in-progress: true");
      expect(syncSection).not.toMatch(
        /group:\s*harness-production-sync-\$\{/,
      );
    });

    it("validates machine JSON via redact-json-file before upload", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("redact-json-file");
      expect(syncSection).toContain("sync-production-raw.json");
      expect(syncSection).toContain("sync-production-output.json");
    });

    it("propagates sync CLI exit after redact and uploads artifact always", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      const syncInvocation = syncSection.indexOf(
        "npx tsx src/index.ts sync-production",
      );
      const exitCapture = syncSection.indexOf("EXIT_CODE=$?");
      const redact = syncSection.indexOf("redact-json-file");
      const exitPropagate = syncSection.indexOf("exit $EXIT_CODE");
      const uploadStep = syncSection.indexOf("Upload sync artifacts");
      const uploadAlways = syncSection.indexOf("if: always()", uploadStep);
      const uploadPath = syncSection.indexOf(
        "path: sync-production-output.json",
        uploadStep,
      );

      expect(syncInvocation).toBeGreaterThanOrEqual(0);
      expect(exitCapture).toBeGreaterThan(syncInvocation);
      expect(redact).toBeGreaterThan(exitCapture);
      expect(exitPropagate).toBeGreaterThan(redact);
      expect(uploadStep).toBeGreaterThan(exitPropagate);
      expect(uploadAlways).toBeGreaterThan(uploadStep);
      expect(uploadPath).toBeGreaterThan(uploadStep);

      // After successful redaction the sync step must propagate the captured CLI
      // exit, not force success (issue-level failures stay nonzero while artifact exists).
      const afterRedact = syncSection.slice(redact, uploadStep);
      expect(afterRedact).toContain("exit $EXIT_CODE");
      expect(afterRedact).not.toMatch(/^\s*exit 0\s*$/m);
    });

    it("uses harness secrets for sync without CURSOR_API_KEY", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("LINEAR_API_KEY");
      expect(syncSection).toContain("HARNESS_GITHUB_TOKEN");
      expect(syncSection).not.toContain("CURSOR_API_KEY");
      expect(syncSection).not.toContain("harness:doctor");
    });

    it("supports workflow_dispatch sync_repo input", () => {
      expect(workflow).toContain("sync_repo:");
    });

    it("supports workflow_dispatch sync_dry_run input defaulting to true", () => {
      expect(workflow).toContain("sync_dry_run:");
      expect(workflow).toMatch(/sync_dry_run:[\s\S]*default:\s*"true"/);
    });

    it("supports review phases in workflow_dispatch phase input and gate validation", () => {
      expect(workflow).toContain("plan_review");
      expect(workflow).toContain("code_review");
      expect(workflow).toContain("code_revision");
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toMatch(
        /auto\|planning\|plan_review\|implementation\|handoff\|code_review\|code_revision\|revision\|merge/,
      );
    });

    it("uses managed GitHub workflow state and public runner env on harness jobs", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");
      for (const section of [gate, runHarness, runMerge, syncSection]) {
        expect(section).toContain("P_DEV_PUBLIC_RUNNER_MODE: \"1\"");
        expect(section).toContain("P_DEV_WORKFLOW_STATE_STORE_MODE: managed_github");
        expect(section).toContain("P_DEV_WORKFLOW_STATE_REPOSITORY:");
        expect(section).toContain("P_DEV_STATE_GITHUB_TOKEN:");
      }
    });

    it("validates sync_dry_run is true or false for workflow_dispatch", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("Validate sync dry run");
      expect(syncSection).toContain("Invalid sync_dry_run value. Expected true or false.");
    });

    it("passes --dry-run to sync-production when dry_run is true", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain('if [ "$SYNC_DRY_RUN" = "true" ]; then');
      expect(syncSection).toContain("SYNC_ARGS+=(--dry-run)");
      expect(syncSection).toContain("Dry run:");
    });

    it("does not dry-run production_promoted repository_dispatch sync", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain('echo "dry_run=false" >> "$GITHUB_OUTPUT"');
    });

    it("supports force workflow_dispatch recovery input", () => {
      expect(workflow).toContain("force:");
      expect(workflow).toContain('FORCE_FLAG="--force"');
    });

    it("validates request id format in gate job without issue key regex", () => {
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toContain("Invalid request id format.");
      expect(gate).not.toContain("^[A-Z]+-[0-9]+$");
    });

    it("validates sync repo id format without hard-coded allowlist", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("^[a-z][a-z0-9-]*$");
      expect(syncSection).not.toContain("target-app|harness");
    });

    it("loads private operator config from HARNESS_CONFIG_JSON_B64 on harness jobs", () => {
      expect(workflow).toContain("HARNESS_CONFIG_JSON_B64: ${{ secrets.HARNESS_CONFIG_JSON_B64 }}");
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(gate).toContain("HARNESS_CONFIG_JSON_B64");
      expect(runHarness).toContain("HARNESS_CONFIG_JSON_B64");
      expect(runMerge).toContain("HARNESS_CONFIG_JSON_B64");
      expect(syncSection).toContain("HARNESS_CONFIG_JSON_B64");
    });

    it("passes HARNESS_CONFIG_FINGERPRINT on run-merge so cloud_config_stale cannot trip on a missing var", () => {
      const runMerge = extractJobSection(workflow, "run-merge");
      expect(runMerge).toContain(
        "HARNESS_CONFIG_FINGERPRINT: ${{ vars.HARNESS_CONFIG_FINGERPRINT }}",
      );
    });

    it("wires evaluation environment on run-harness, run-merge, and sync-production but not gate", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");

      expect(runHarness).toContain("P_DEV_EVALUATION_PROVIDER");
      expect(runHarness).toContain("LANGFUSE_SECRET_KEY");
      expect(runMerge).toContain("P_DEV_EVALUATION_PROVIDER");
      expect(runMerge).toContain("LANGFUSE_SECRET_KEY");
      expect(syncSection).toContain("P_DEV_EVALUATION_PROVIDER");
      expect(syncSection).toContain("LANGFUSE_SECRET_KEY");
      expect(syncSection).toContain("VERCEL_TOKEN");
      expect(syncSection).toContain("P_DEV_WORKFLOW_STATE_STORE_MODE: managed_github");

      expect(gate).not.toContain("LANGFUSE_SECRET_KEY");
    });

    it("resolves dual-commit provenance before harness jobs via GITHUB_ENV", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      for (const section of [runHarness, runMerge]) {
        expect(section).toContain("Resolve runtime provenance");
        expect(section).toContain("write-github-provenance-env.ts");
        expect(section).not.toMatch(
          /^\s+LANGFUSE_RELEASE:\s*\$\{\{\s*github\.sha\s*\}\}/m,
        );
      }
    });

    it("forwards dispatch metadata to sync-production CLI", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("--source-repo");
      expect(syncSection).toContain("--production-branch");
      expect(syncSection).toContain("--ref");
    });

    it("uploads public-safe harness artifacts without issue-key paths", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      for (const section of [runHarness, runMerge]) {
        expect(section).toContain("name: harness-run-${{ github.run_id }}");
        expect(section).toContain("runs/public-summary-${{ github.run_id }}.json");
        expect(section).not.toContain("runs/${{ needs.gate.outputs.issue_key }}");
      }
    });

    it("never references HARNESS_ISSUE_KEY or issue-key env dumps in public jobs", () => {
      expect(workflow).not.toContain("HARNESS_ISSUE_KEY");
      expect(workflow).not.toContain("ISSUE_KEY: ${{ env.");
      expect(workflow).not.toContain("--issue \"$HARNESS_ISSUE_KEY\"");
    });
  });
}

describe("harness-auto-runner workflow contracts", () => {
  assertHarnessWorkflowContracts(readFileSync(liveWorkflowPath, "utf8"), "live");
  assertHarnessWorkflowContracts(readFileSync(fixtureWorkflowPath, "utf8"), "fixture");
});

describe("harness-auto-runner concurrency behavior contracts", () => {
  const workflow = readFileSync(liveWorkflowPath, "utf8");
  const runHarness = extractJobSection(workflow, "run-harness");
  const runMerge = extractJobSection(workflow, "run-merge");

  it("duplicate same-request non-merge dispatch queues via run-harness concurrency without cancel", () => {
    expect(runHarness).toContain("harness-req-${{ needs.gate.outputs.request_id }}");
    expect(runHarness).toContain("cancel-in-progress: false");
  });

  it("duplicate same-issue merge dispatch queues via run-merge concurrency without cancel", () => {
    expect(runMerge).toContain("harness-merge-${{ needs.gate.outputs.merge_concurrency_group }}");
    expect(runMerge).toContain("cancel-in-progress: false");
    expect(runMerge).toContain("queue: max");
  });

  it("different requests in non-merge phases use distinct run-harness groups", () => {
    expect(runHarness).toContain("needs.gate.outputs.request_id");
  });

  it("different issues targeting same repo/base branch share merge queue group output", () => {
    expect(runMerge).toContain("needs.gate.outputs.merge_concurrency_group");
  });
});

describe("harness-auto-runner cursor provenance step wiring", () => {
  const cursorCapableJobs = ["run-harness", "run-merge"] as const;

  function assertProvenanceWiring(doc: WorkflowDoc, label: string): void {
    expect(doc.jobs, `${label} jobs`).toBeDefined();
    const jobs = doc.jobs!;

    for (const jobName of cursorCapableJobs) {
      const job = jobs[jobName];
      expect(job, `${label} ${jobName}`).toBeDefined();
      expect(job.env?.[MODE_ENV], `${label} ${jobName} job-level mode`).toBeUndefined();
      expect(job.env?.[KEY_ENV], `${label} ${jobName} job-level key`).toBeUndefined();
    }

    const runHarness = jobs["run-harness"]!;
    assertCursorProvenanceStepEnv(stepByName(runHarness, "Doctor"), `${label} run-harness Doctor`);
    assertCursorProvenanceStepEnv(
      stepByName(runHarness, "Run harness"),
      `${label} run-harness Run harness`,
    );

    const runMerge = jobs["run-merge"]!;
    assertCursorProvenanceStepEnv(stepByName(runMerge, "Doctor"), `${label} run-merge Doctor`);
    assertCursorProvenanceStepEnv(
      stepByName(runMerge, "Run merge"),
      `${label} run-merge Run merge`,
    );

    for (const jobName of cursorCapableJobs) {
      const job = jobs[jobName]!;
      for (const step of job.steps ?? []) {
        const run = step.run ?? "";
        const isCursorCapable =
          /harness:doctor\b/.test(run) || /harness:run\b/.test(run);
        if (!isCursorCapable) continue;
        assertCursorProvenanceStepEnv(step, `${label} ${jobName}/${step.name ?? "?"}`);
      }
    }

    for (const stepName of [
      "Checkout harness repo",
      "Setup Node.js",
      "Install dependencies",
      "Build",
    ]) {
      for (const jobName of cursorCapableJobs) {
        const step = (jobs[jobName]!.steps ?? []).find((s) => s.name === stepName);
        if (!step) continue;
        expect(step.env?.[KEY_ENV], `${label} ${jobName}/${stepName} key`).toBeUndefined();
        expect(step.env?.[MODE_ENV], `${label} ${jobName}/${stepName} mode`).toBeUndefined();
      }
    }

    for (const jobName of ["gate", "sync-production"] as const) {
      const job = jobs[jobName];
      expect(job, `${label} ${jobName}`).toBeDefined();
      expect(job!.env?.[KEY_ENV], `${label} ${jobName} job key`).toBeUndefined();
      expect(job!.env?.[MODE_ENV], `${label} ${jobName} job mode`).toBeUndefined();
      for (const step of job!.steps ?? []) {
        expect(step.env?.[KEY_ENV], `${label} ${jobName}/${step.name} key`).toBeUndefined();
        expect(step.env?.[MODE_ENV], `${label} ${jobName}/${step.name} mode`).toBeUndefined();
      }
    }
  }

  it("wires provenance mode and key at step scope on live and fixture workflows", () => {
    const live = loadWorkflowDoc(liveWorkflowPath);
    const fixture = loadWorkflowDoc(fixtureWorkflowPath);
    assertProvenanceWiring(live, "live");
    assertProvenanceWiring(fixture, "fixture");
  });

  it("keeps live and fixture provenance wiring in lockstep", () => {
    const live = loadWorkflowDoc(liveWorkflowPath);
    const fixture = loadWorkflowDoc(fixtureWorkflowPath);
    const extract = (doc: WorkflowDoc) => {
      const rh = doc.jobs!["run-harness"]!;
      const rm = doc.jobs!["run-merge"]!;
      return {
        runHarnessDoctor: stepByName(rh, "Doctor").env,
        runHarnessExec: stepByName(rh, "Run harness").env,
        runMergeDoctor: stepByName(rm, "Doctor").env,
        runMergeExec: stepByName(rm, "Run merge").env,
      };
    };
    expect(extract(live)).toEqual(extract(fixture));
  });

  it("never uses the obsolete P_DEV_PROVENANCE_MODE name", () => {
    for (const filePath of [liveWorkflowPath, fixtureWorkflowPath]) {
      const text = readFileSync(filePath, "utf8");
      expect(text).not.toContain(OBSOLETE_MODE_ENV);
      const doc = loadWorkflowDoc(filePath);
      for (const job of Object.values(doc.jobs ?? {})) {
        expect(job.env?.[OBSOLETE_MODE_ENV]).toBeUndefined();
        for (const step of job.steps ?? []) {
          expect(step.env?.[OBSOLETE_MODE_ENV]).toBeUndefined();
        }
      }
    }
  });
});

describe("cursor provenance key excluded from non-cursor workflows", () => {
  const nonCursorWorkflows = [
    "harness-reconcile-production.yml",
    "harness-reconcile-revisions.yml",
    "evaluation-canary-native-skill.yml",
    "evaluation-canary-langfuse-projection.yml",
    "evaluation-inspect-langfuse.yml",
    "p-dev-runner-config-canary.yml",
    "private-state-canary.yml",
    "public-runner-smoke.yml",
    "ci.yml",
    "codeql.yml",
  ] as const;

  it("does not expose P_DEV_PROVENANCE_KEY_V1 outside harness-auto-runner", () => {
    for (const name of nonCursorWorkflows) {
      const filePath = path.join(workflowsDir, name);
      const text = readFileSync(filePath, "utf8");
      expect(text, name).not.toContain(KEY_ENV);
      expect(text, name).not.toContain(MODE_ENV);
      expect(text, name).not.toContain(OBSOLETE_MODE_ENV);
    }
  });

  it("lists every workflow file so new probe workflows are scanned", () => {
    const onDisk = readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
    const expected = [...nonCursorWorkflows, "harness-auto-runner.yml"].sort();
    expect(onDisk).toEqual(expected);
  });
});
