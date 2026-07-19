/**
 * Cursor SDK runs can leave active handles after a successful phase chain.
 * Explicitly exit so GitHub Actions does not hold per-issue concurrency open.
 */
export function finalizeCliExit(exitCode: number | string | null | undefined): never {
  const code =
    typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : 0;
  process.exit(code);
}
