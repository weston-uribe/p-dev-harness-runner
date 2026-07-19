#!/usr/bin/env node
/**
 * Production-style assertion: compiled dist/ evaluation assets load without source fallback.
 * Used by p-dev-runner-config-canary after npm run build.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function requirePath(relativePath) {
  const absolute = path.join(root, relativePath);
  try {
    await access(absolute);
  } catch {
    throw new Error(`Missing required built asset: ${relativePath}`);
  }
  return absolute;
}

async function main() {
  const distLoad = await requirePath("dist/evaluation/rubrics/load.js");
  await requirePath(
    "dist/evaluation/rubrics/definitions/implementation-quality.v1.json",
  );
  await requirePath(
    "dist/evaluation/rubrics/definitions/execution-contract.v1.json",
  );
  await requirePath(
    "dist/evaluation/evaluators/implementations.manifest.json",
  );
  await requirePath(
    "dist/evaluation/evaluators/policies/dataset-readiness.v1.json",
  );
  await requirePath(
    "dist/evaluation/evaluators/contracts/workflow-state-machine.v1.json",
  );

  const mod = await import(pathToFileURL(distLoad).href);
  if (typeof mod.loadAllRubrics !== "function") {
    throw new Error("dist/evaluation/rubrics/load.js missing loadAllRubrics export");
  }

  const rubrics = await mod.loadAllRubrics();
  if (!Array.isArray(rubrics) || rubrics.length !== 8) {
    throw new Error(
      `Expected 8 rubrics from dist loader, got ${Array.isArray(rubrics) ? rubrics.length : typeof rubrics}`,
    );
  }

  const machineCount = rubrics.filter(
    (r) => r.judgmentChannel === "machine",
  ).length;
  if (machineCount !== 4) {
    throw new Error(`Expected 4 machine rubrics, got ${machineCount}`);
  }

  const manifestPath = path.join(
    root,
    "dist/evaluation/evaluators/implementations.manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.evaluators) ||
    manifest.evaluators.length === 0
  ) {
    throw new Error("Invalid evaluator implementation manifest shape");
  }

  const policyPath = path.join(
    root,
    "dist/evaluation/evaluators/policies/dataset-readiness.v1.json",
  );
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  if (policy.policyId !== "dataset-readiness") {
    throw new Error("Invalid dataset-readiness policy");
  }

  const contractPath = path.join(
    root,
    "dist/evaluation/evaluators/contracts/workflow-state-machine.v1.json",
  );
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  if (contract.stateMachineId !== "harness-workflow") {
    throw new Error("Invalid workflow state-machine contract");
  }

  console.log(
    JSON.stringify({
      ok: true,
      rubricCount: rubrics.length,
      machineRubricCount: machineCount,
      evaluatorCount: manifest.evaluators.length,
    }),
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
