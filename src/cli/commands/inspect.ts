import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readManifest } from "../../artifacts/manifest.js";
import { getManifestPath, getSummaryPath } from "../../artifacts/paths.js";
import { EXIT_CONFIG, EXIT_SUCCESS } from "../exit-codes.js";

export interface InspectOptions {
  runPath: string;
}

export async function runInspect(options: InspectOptions): Promise<number> {
  const runDirectory = path.resolve(options.runPath);
  const manifestPath = getManifestPath(runDirectory);

  try {
    await access(manifestPath, constants.F_OK);
  } catch {
    console.error(`Run directory is missing manifest.json: ${runDirectory}`);
    return EXIT_CONFIG;
  }

  const manifest = await readManifest(runDirectory);

  console.log("Harness run inspect");
  console.log(`- Run ID: ${manifest.runId}`);
  console.log(`- Issue: ${manifest.issueKey}`);
  console.log(`- Phase: ${manifest.phase}`);
  console.log(`- Status: ${manifest.phaseInferredFromStatus ?? "unknown"}`);
  console.log(`- Target repo: ${manifest.targetRepo ?? "none"}`);
  console.log(`- Outcome: ${manifest.finalOutcome}`);
  console.log(`- Error: ${manifest.errorClassification ?? "none"}`);
  console.log(`- Started: ${manifest.startedAt}`);
  console.log(`- Finished: ${manifest.finishedAt}`);

  try {
    const summary = await readFile(getSummaryPath(runDirectory), "utf8");
    console.log("\n--- run-summary.md ---\n");
    console.log(summary.trimEnd());
  } catch {
    console.log("\n(run-summary.md not found)");
  }

  return EXIT_SUCCESS;
}
