import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeFatalHarness(
  dir: string,
  body: string,
): Promise<string> {
  const scriptPath = path.join(dir, "fatal-harness.mjs");
  await writeFile(scriptPath, body, "utf8");
  return scriptPath;
}

function runNodeScript(scriptPath: string, env: NodeJS.ProcessEnv = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = error as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: execError.status ?? 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
    };
  }
}

describe("observability fatal process semantics", () => {
  it("exits nonzero on uncaught exception with observability enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fatal-uncaught-"));
    tempDirs.push(dir);
    const scriptPath = await writeFatalHarness(
      dir,
      `
import { installObservabilityFatalHandlers } from ${JSON.stringify(path.join(repoRoot, "dist/observability/fatal-handlers.js"))};

installObservabilityFatalHandlers(() => {});
setTimeout(() => {
  throw new Error("fatal test");
}, 10);
`,
    );
    const result = runNodeScript(scriptPath);
    expect(result.status).not.toBe(0);
  });

  it("exits nonzero on uncaught exception with observability disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fatal-uncaught-off-"));
    tempDirs.push(dir);
    const scriptPath = await writeFatalHarness(
      dir,
      `
setTimeout(() => {
  throw new Error("fatal test without observability");
}, 10);
`,
    );
    const result = runNodeScript(scriptPath);
    expect(result.status).not.toBe(0);
  });

  it("exits nonzero on unhandled rejection under strict mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fatal-rejection-"));
    tempDirs.push(dir);
    const scriptPath = await writeFatalHarness(
      dir,
      `
Promise.reject(new Error("unhandled rejection"));
setTimeout(() => {}, 100);
`,
    );
    const result = runNodeScript(scriptPath, {
      NODE_OPTIONS: "--unhandled-rejections=strict",
    });
    expect(result.status).not.toBe(0);
  });
});
