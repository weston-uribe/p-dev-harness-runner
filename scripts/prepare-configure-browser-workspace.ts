#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function ensureGitRepo(dir: string): Promise<void> {
  const gitDir = path.join(dir, ".git");
  try {
    await access(gitDir);
  } catch {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "configure-browser@test.local"], {
      cwd: dir,
    });
    await execFileAsync("git", ["config", "user.name", "Configure Browser Test"], {
      cwd: dir,
    });
  }

  try {
    await execFileAsync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/weston-uribe/agentic-product-development-harness.git",
      ],
      { cwd: dir },
    );
  } catch {
    await execFileAsync(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        "https://github.com/weston-uribe/agentic-product-development-harness.git",
      ],
      { cwd: dir },
    );
  }
}

async function main(): Promise<void> {
  const configured = process.env.CONFIGURE_BROWSER_WORKSPACE?.trim();
  const workspaceDir =
    configured ||
    path.join(tmpdir(), `configure-browser-${process.pid}-${Date.now()}`);

  await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
  await ensureGitRepo(workspaceDir);

  await writeFile(
    path.join(workspaceDir, ".env.local"),
    [
      "LINEAR_API_KEY=linear-browser-test-token",
      "CURSOR_API_KEY=cursor-browser-test-token",
      "GITHUB_TOKEN=github-browser-test-token",
      "VERCEL_TOKEN=vercel-browser-test-token",
      "HARNESS_CONFIG_PATH=.harness/config.local.json",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(workspaceDir, ".harness/config.local.json"),
    `${JSON.stringify(
      {
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
            baseBranch: "dev",
            productionBranch: "main",
          },
        ],
        linearTeamKey: "ENG",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(workspaceDir, ".harness/control-plane-setup.json"),
    `${JSON.stringify(
      {
        version: 1,
        linear: {
          teamMode: "existing",
          teamId: "team-1",
          teamKey: "ENG",
          teamName: "Engineering",
          projectMode: "existing",
          projectId: "proj-1",
          projectName: "Harness",
          statusCoverageComplete: true,
          appliedAt: "2026-07-16T00:00:00.000Z",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const skipDisclosure = process.env.CONFIGURE_BROWSER_SKIP_DISCLOSURE === "1";
  if (!skipDisclosure) {
    await writeFile(
      path.join(workspaceDir, ".harness/observability.local.json"),
      `${JSON.stringify(
        {
          analyticsPreference: "disabled",
          errorReportingPreference: "disabled",
          disclosureShown: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  process.stdout.write(`${workspaceDir}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prepare-configure-browser-workspace failed: ${message}`);
  process.exit(1);
});
