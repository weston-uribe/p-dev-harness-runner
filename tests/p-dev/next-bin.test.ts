import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveNextBin } from "../../src/p-dev/next-bin.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("resolveNextBin", () => {
  it("resolves the Next.js CLI entrypoint from the package dependency tree", () => {
    const nextBin = resolveNextBin(repoRoot);
    expect(nextBin).toContain(`${path.sep}next${path.sep}dist${path.sep}bin${path.sep}next`);
  });
});
