import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Regenerate evaluator implementation manifest from source modules.
const gen = spawnSync(
  process.execPath,
  [path.join(root, "scripts/generate-evaluator-manifest.mjs")],
  { stdio: "inherit" },
);
if (gen.status !== 0) {
  process.exit(gen.status ?? 1);
}

const copies = [
  {
    src: path.join(root, "src/evaluation/rubrics/definitions"),
    dest: path.join(root, "dist/evaluation/rubrics/definitions"),
  },
  {
    src: path.join(root, "src/evaluation/evaluators/policies"),
    dest: path.join(root, "dist/evaluation/evaluators/policies"),
  },
  {
    src: path.join(root, "src/evaluation/evaluators/contracts"),
    dest: path.join(root, "dist/evaluation/evaluators/contracts"),
  },
];

for (const { src, dest } of copies) {
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`Copied evaluation assets to ${dest}`);
}

// Copy JSON manifests next to compiled evaluators
const jsonFiles = [
  "implementations.descriptor.json",
  "implementations.manifest.json",
];
for (const name of jsonFiles) {
  const src = path.join(root, "src/evaluation/evaluators", name);
  const dest = path.join(root, "dist/evaluation/evaluators", name);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest);
  console.log(`Copied ${name} to ${dest}`);
}
