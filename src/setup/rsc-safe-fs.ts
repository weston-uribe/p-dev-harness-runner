import { existsSync, readFileSync } from "node:fs";

/**
 * Read local files without `fs.promises.readFile`.
 *
 * Next.js 15 development Flight/RSC debug instrumentation serializes the
 * resolved values of awaited Node fs promises into the browser-visible RSC
 * stream (including raw `.env.local` and config bytes). Synchronous reads are
 * not attached as Flight async-debug `readFile` value nodes, so secret-bearing
 * and config file contents stay off the server-to-browser boundary.
 *
 * Prefer these helpers for any filesystem read that may contain credentials,
 * raw env files, or local config bytes on GUI/RSC request paths.
 */
export function readTextFileSyncIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf8");
}

export function readBinaryFileSync(filePath: string): Buffer {
  return readFileSync(filePath);
}

export function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}
