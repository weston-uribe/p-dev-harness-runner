import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("compatibility launcher scripts", () => {
  it("routes harness scripts through the Node bootstrap", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["harness:gui"]).toBe("node bin/p-dev-dev.js");
    expect(manifest.scripts["harness:configure"]).toBe(
      "node bin/p-dev-dev.js --deprecation-notice=configure",
    );
    expect(manifest.scripts["harness:configure:stable"]).toBe(
      "node bin/p-dev-dev.js --deprecation-notice=configure",
    );
    // Conventional command meaning: start/p-dev = operator; dev = hot reload.
    expect(manifest.scripts.start).toBe("node bin/p-dev-dev.js");
    expect(manifest.scripts.dev).toBe("node bin/gui-dev.js");
    expect(manifest.scripts["gui:dev"]).toBe("node bin/gui-dev.js");
    expect(manifest.scripts["harness:gui:doctor"]).toBe(
      "tsx src/gui/gui-doctor.ts",
    );
  });
});
