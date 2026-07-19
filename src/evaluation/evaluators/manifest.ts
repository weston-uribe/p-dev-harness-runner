import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ImplementationManifestEntry {
  evaluatorId: string;
  evaluatorVersion: string;
  implementationVersion: string;
  sourceModule: string;
  sourceModuleContentHash: string;
  sharedDependencies: Array<{ module: string; contentHash: string }>;
  implementationHash: string;
}

export interface ImplementationManifest {
  schemaVersion: 1;
  generatedFrom: string;
  evaluators: ImplementationManifestEntry[];
}

function manifestPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "implementations.manifest.json");
}

export function getImplementationManifestPath(): string {
  return manifestPath();
}

export async function loadImplementationManifest(
  filePath = manifestPath(),
): Promise<ImplementationManifest> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ImplementationManifest;
  if (!parsed || !Array.isArray(parsed.evaluators)) {
    throw new Error(`Invalid implementation manifest at ${filePath}`);
  }
  return parsed;
}

export async function getImplementationHash(
  evaluatorId: string,
  evaluatorVersion: string,
): Promise<string> {
  const manifest = await loadImplementationManifest();
  const entry = manifest.evaluators.find(
    (e) =>
      e.evaluatorId === evaluatorId && e.evaluatorVersion === evaluatorVersion,
  );
  if (!entry) {
    throw new Error(
      `No implementation hash for ${evaluatorId}@${evaluatorVersion}`,
    );
  }
  return entry.implementationHash;
}
