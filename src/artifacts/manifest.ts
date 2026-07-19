import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { RunManifest } from "../types/run.js";
import { getManifestPath } from "./paths.js";

export async function writeManifest(
  runDirectory: string,
  manifest: RunManifest,
): Promise<void> {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    getManifestPath(runDirectory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function readManifest(runDirectory: string): Promise<RunManifest> {
  const raw = await readFile(getManifestPath(runDirectory), "utf8");
  return JSON.parse(raw) as RunManifest;
}
