/**
 * Writes dual-commit provenance to $GITHUB_ENV for harness-auto-runner jobs.
 * Fails closed when the managed marker is missing or malformed in CI.
 */
import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  isCommitSha,
  parseManagedMarkerSourceCommit,
} from "../evaluation/runtime-provenance.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "../setup/harness-managed-repo-marker.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function writeEnv(key: string, value: string): void {
  const file = process.env.GITHUB_ENV;
  if (!file) {
    fail("GITHUB_ENV is not set");
  }
  appendFileSync(file, `${key}=${value}\n`, "utf8");
}

const markerPath = path.join(process.cwd(), HARNESS_MANAGED_REPO_MARKER_FILE);
let markerRaw: string;
try {
  markerRaw = readFileSync(markerPath, "utf8");
} catch {
  fail(
    `Managed repository marker missing at ${HARNESS_MANAGED_REPO_MARKER_FILE}`,
  );
}

const harnessSourceCommit = parseManagedMarkerSourceCommit(markerRaw);
if (!harnessSourceCommit) {
  fail(
    `createdFromPackageSnapshot.sourceCommit is missing or not a valid commit SHA in ${HARNESS_MANAGED_REPO_MARKER_FILE}`,
  );
}

const managedRunnerCommit = process.env.GITHUB_SHA?.trim() ?? "";
if (!isCommitSha(managedRunnerCommit)) {
  fail("GITHUB_SHA is missing or not a valid commit SHA");
}

writeEnv("HARNESS_SOURCE_COMMIT", harnessSourceCommit);
writeEnv("MANAGED_RUNNER_COMMIT", managedRunnerCommit.toLowerCase());
writeEnv("LANGFUSE_RELEASE", harnessSourceCommit);

console.log(
  `Resolved runtime provenance: harnessSourceCommit=${harnessSourceCommit.slice(0, 7)} managedRunnerCommit=${managedRunnerCommit.slice(0, 7)}`,
);
