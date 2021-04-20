import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("root package bin", () => {
  it("exposes the local p-dev bin and dev script", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(manifest.bin["p-dev"]).toBe("./bin/p-dev-dev.js");
    expect(manifest.scripts.dev).toBe("node bin/gui-dev.js");
    expect(manifest.scripts.start).toBe("node bin/p-dev-dev.js");
    expect(manifest.scripts["p-dev:install"]).toBe(
      "tsx scripts/install-p-dev-local.ts",
    );
  });
});
