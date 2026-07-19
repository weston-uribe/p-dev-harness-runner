import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evaluatorsDir = path.join(root, "src/evaluation/evaluators");
const descriptorPath = path.join(
  evaluatorsDir,
  "implementations.descriptor.json",
);
const manifestPath = path.join(evaluatorsDir, "implementations.manifest.json");

function sha256File(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
const fileHashCache = new Map();

async function hashModule(rel) {
  if (fileHashCache.has(rel)) return fileHashCache.get(rel);
  const abs = path.join(evaluatorsDir, rel);
  const content = await readFile(abs, "utf8");
  const hash = sha256File(content);
  fileHashCache.set(rel, hash);
  return hash;
}

const evaluators = [];
for (const mod of descriptor.modules) {
  const sourceHash = await hashModule(mod.sourceModule);
  const shared = [];
  for (const dep of mod.sharedDependencies ?? []) {
    shared.push({ module: dep, contentHash: await hashModule(dep) });
  }
  const implPayload = [
    mod.evaluatorId,
    mod.evaluatorVersion,
    mod.implementationVersion,
    sourceHash,
    ...shared.map((s) => `${s.module}:${s.contentHash}`).sort(),
  ].join("|");
  const implementationHash = sha256File(implPayload);
  evaluators.push({
    evaluatorId: mod.evaluatorId,
    evaluatorVersion: mod.evaluatorVersion,
    implementationVersion: mod.implementationVersion,
    sourceModule: mod.sourceModule,
    sourceModuleContentHash: sourceHash,
    sharedDependencies: shared,
    implementationHash,
  });
}

const manifest = {
  schemaVersion: 1,
  generatedFrom: "implementations.descriptor.json",
  evaluators,
};

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `Wrote evaluator implementation manifest (${evaluators.length} evaluators) to ${manifestPath}`,
);
