import {
  formatManifestSummaryLines,
  readManifestSubsetFromFile,
} from "./manifest-summary.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: summarize-manifest <json-path>");
  process.exit(1);
}

const subset = readManifestSubsetFromFile(path);
if (!subset) {
  console.log("- Manifest: (unavailable or invalid JSON)");
  process.exit(0);
}

for (const line of formatManifestSummaryLines(subset)) {
  console.log(line);
}
