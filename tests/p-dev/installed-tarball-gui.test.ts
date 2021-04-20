import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packCurrentTarballIfNeededAsync } from "./helpers/async-package-pack.js";
import { readWorkflowConfigSnapshot } from "../../src/setup/workflow-config-snapshot.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageDir = path.join(repoRoot, "packages", "p-dev");

const GENERATED_PACKAGE_OUTPUT_PREFIXES = [
  "packages/p-dev/bin/",
  "packages/p-dev/dist/",
  "packages/p-dev/gui/",
  "packages/p-dev/templates/",
  "packages/p-dev/workspace-snapshot/",
] as const;

function isIgnorableDirtyPackagePath(filePath: string): boolean {
  return GENERATED_PACKAGE_OUTPUT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

function isCleanEnoughForPackagePack(): boolean {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .every((line) => isIgnorableDirtyPackagePath(line.slice(3).trim()));
}


function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve free port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function followRedirectChain(
  startUrl: string,
  maxHops = 10,
): Promise<{
  chain: Array<{ url: string; status: number; location: string | null }>;
  finalUrl: string;
  finalStatus: number;
}> {
  const chain: Array<{ url: string; status: number; location: string | null }> =
    [];
  let url = startUrl;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    chain.push({ url, status: response.status, location });
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return {
        chain,
        finalUrl: url,
        finalStatus: response.status,
      };
    }
    url = new URL(location, url).href;
  }

  throw new Error(`Exceeded redirect hop limit for ${startUrl}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function launchInstalledGui(input: {
  installDir: string;
  packageRoot: string;
  workspaceDir: string;
  port: number;
}): Promise<ChildProcessWithoutNullStreams> {
  const launcher = path.join(input.packageRoot, "bin/p-dev.js");
  const child = spawn(
    process.execPath,
    [
      launcher,
      "--workspace",
      input.workspaceDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--no-open",
    ],
    {
      cwd: input.installDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_HOME: input.workspaceDir,
        P_DEV_OBSERVABILITY_DISABLED: "1",
        P_DEV_ANALYTICS_DISABLED: "1",
        P_DEV_SENTRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
      },
      stdio: "pipe",
    },
  ) as ChildProcessWithoutNullStreams;

  const baseUrl = `http://127.0.0.1:${input.port}`;
  await waitForHttpOk(`${baseUrl}/settings/configure`, 120_000);
  return child;
}

const COMPLETED_CONFIG = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      productionBranch: "main",
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  roleModels: {
    planner: { id: "planner-live-model", params: [{ id: "fast", value: "false" }] },
    builder: { id: "builder-live-model", params: [{ id: "fast", value: "false" }] },
  },
};

async function seedCompletedWorkspace(workspaceDir: string): Promise<string> {
  await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, ".env.local"),
    [
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "LINEAR_API_KEY=linear-test-key",
      "CURSOR_API_KEY=cursor-test-key",
      "GITHUB_TOKEN=github-test-token",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(workspaceDir, ".harness", "config.local.json"),
    `${JSON.stringify(COMPLETED_CONFIG, null, 2)}\n`,
    "utf8",
  );
  // Live Workflow bootstrap fingerprints the raw config.local.json bytes.
  const { fingerprint } = await readWorkflowConfigSnapshot(workspaceDir);
  await writeFile(
    path.join(workspaceDir, ".harness", "control-plane-setup.json"),
    `${JSON.stringify(
      {
        version: 1,
        linear: {
          teamMode: "existing",
          teamId: "team-1",
          teamKey: "TEAM",
          teamName: "Team",
          projectMode: "existing",
          projectId: "project-1",
          projectName: "Project",
          statusCoverageComplete: true,
        },
        workflowModels: {
          configFingerprint: fingerprint,
          harnessRepository: "owner/harness-repo",
          syncedAt: "2026-01-01T00:00:00.000Z",
        },
        initialSetup: {
          status: "complete",
          completedAt: "2026-01-01T00:00:00.000Z",
          completionEvidence: {
            localConfigPresent: true,
            linearConfigured: true,
            vercelConfigured: true,
            cloudSecretsVerified: true,
            targetWorkflowsVerified: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return fingerprint;
}

describe.skipIf(!isCleanEnoughForPackagePack())(
  "installed tarball GUI smoke",
  () => {
    let tarballPath = "";
    let installDir = "";
    let packageRoot = "";

    beforeAll(async () => {
      tarballPath = await packCurrentTarballIfNeededAsync({
        repoRoot,
        packageDir,
      });
      installDir = await mkdtemp(path.join(os.tmpdir(), "p-dev-gui-install-"));
      execFileSync(
        "npm",
        ["install", "--no-save", `file:${tarballPath}`],
        {
          cwd: installDir,
          stdio: "pipe",
        },
      );
      packageRoot = path.join(installDir, "node_modules", "p-dev-harness");
    }, 240_000);

    afterAll(async () => {
      await rm(installDir, { recursive: true, force: true });
    });

    it("fresh workspace redirects to Configure and stops cleanly", async () => {
      const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "p-dev-fresh-home-"));
      const port = await getFreePort();
      let child: ChildProcessWithoutNullStreams | undefined;

      try {
        child = await launchInstalledGui({
          installDir,
          packageRoot,
          workspaceDir,
          port,
        });

        const followed = await followRedirectChain(`http://127.0.0.1:${port}/`);
        expect(followed.chain[0]?.status).toBeGreaterThanOrEqual(307);
        expect(followed.chain[0]?.location).toMatch(/\/settings\/configure$/);
        expect(followed.finalUrl).toMatch(/\/settings\/configure$/);
        expect(followed.finalStatus).toBe(200);

        const configureResponse = await fetch(
          `http://127.0.0.1:${port}/settings/configure`,
        );
        expect(configureResponse.status).toBe(200);
      } finally {
        if (child) {
          await stopChild(child);
        }
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }, 180_000);

    it("completed workspace serves live Workflow from operator config", async () => {
      const workspaceDir = await mkdtemp(
        path.join(os.tmpdir(), "p-dev-completed-home-"),
      );
      const expectedFingerprint = await seedCompletedWorkspace(workspaceDir);
      const port = await getFreePort();
      let child: ChildProcessWithoutNullStreams | undefined;

      try {
        child = await launchInstalledGui({
          installDir,
          packageRoot,
          workspaceDir,
          port,
        });

        const followed = await followRedirectChain(`http://127.0.0.1:${port}/`);
        expect(followed.chain[0]?.status).toBeGreaterThanOrEqual(307);
        expect(followed.finalUrl).toMatch(/\/workflow$/);
        expect(followed.finalStatus).toBe(200);

        const workflowResponse = await fetch(`http://127.0.0.1:${port}/workflow`);
        expect(workflowResponse.status).toBe(200);
        const workflowHtml = await workflowResponse.text();
        expect(workflowHtml).toContain("Workflow");
        expect(workflowHtml).toContain("planner-live-model");
        expect(workflowHtml).toContain("builder-live-model");

        const bootstrapResponse = await fetch(
          `http://127.0.0.1:${port}/api/workflow/bootstrap`,
        );
        expect(bootstrapResponse.status).toBe(200);
        const bootstrap = (await bootstrapResponse.json()) as {
          sourceMode: string;
          configFingerprint: string;
          plannerSelection: { modelId: string; source: string };
          builderSelection: { modelId: string; source: string };
          scopes: Array<{ id: string }>;
          warnings: string[];
        };
        expect(bootstrap.sourceMode).toBe("live");
        expect(bootstrap.configFingerprint).toBe(expectedFingerprint);
        expect(bootstrap.plannerSelection.modelId).toBe("planner-live-model");
        expect(bootstrap.builderSelection.modelId).toBe("builder-live-model");
        expect(bootstrap.plannerSelection.source).toBe("roleModels");
        expect(bootstrap.builderSelection.source).toBe("roleModels");
        expect(bootstrap.scopes.some((scope) => scope.id === "target-app")).toBe(
          true,
        );
        expect(
          bootstrap.warnings.some((warning) =>
            warning.includes("cloud configuration is not synchronized"),
          ),
        ).toBe(false);

        const configureResponse = await fetch(
          `http://127.0.0.1:${port}/settings/configure`,
        );
        expect(configureResponse.status).toBe(200);

        const deploymentsResponse = await fetch(
          `http://127.0.0.1:${port}/settings/deployments`,
        );
        expect(deploymentsResponse.status).toBe(200);
        const deploymentsHtml = await deploymentsResponse.text();
        // Runner upgrade card is disabled by default for 0.4.
        expect(deploymentsHtml).toContain("Deployments");
        expect(deploymentsHtml).not.toContain("Update PDev runner");
        expect(deploymentsHtml).toMatch(/Vercel|deployment bridge|Deployments/i);
      } finally {
        if (child) {
          await stopChild(child);
        }
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }, 180_000);

    it("optional fixture packaging smoke requires explicit server opt-in", async () => {
      const listing = execFileSync("tar", ["-tzf", tarballPath], {
        encoding: "utf8",
      });
      expect(listing).toContain(
        "package/workspace-snapshot/files/src/workflow-page/fixtures/branching-pr-review.ts",
      );

      const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "p-dev-fixture-home-"));
      const port = await getFreePort();
      let child: ChildProcessWithoutNullStreams | undefined;

      try {
        child = spawn(
          process.execPath,
          [
            path.join(packageRoot, "bin/p-dev.js"),
            "--workspace",
            workspaceDir,
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--no-open",
          ],
          {
            cwd: installDir,
            env: {
              ...process.env,
              NODE_ENV: "production",
              P_DEV_RUNTIME_MODE: "packaged",
              P_DEV_HOME: workspaceDir,
              P_DEV_WORKFLOW_FIXTURES: "1",
              P_DEV_OBSERVABILITY_DISABLED: "1",
            },
            stdio: "pipe",
          },
        ) as ChildProcessWithoutNullStreams;

        await waitForHttpOk(`http://127.0.0.1:${port}/settings/configure`, 120_000);

        const bootstrapResponse = await fetch(
          `http://127.0.0.1:${port}/api/workflow/bootstrap?source=fixture&fixture=branching-pr-review&scope=harness-repo`,
        );
        expect(bootstrapResponse.status).toBe(200);
        const bootstrap = (await bootstrapResponse.json()) as { sourceMode: string };
        expect(bootstrap.sourceMode).toBe("fixture");
      } finally {
        if (child) {
          await stopChild(child);
        }
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
