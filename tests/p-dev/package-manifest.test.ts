import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("p-dev package manifest", () => {
  it("declares publishable package metadata for the current package version", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/p-dev/package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      private?: boolean;
      license: string;
      bin: Record<string, string>;
      engines: { node: string };
      files: string[];
      publishConfig: { access: string };
      repository: { directory: string };
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("p-dev-harness");
    expect(manifest.version).toBe("0.4.0");
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("MIT");
    expect(manifest.bin["p-dev-harness"]).toBe("./bin/p-dev.js");
    expect(manifest.bin["p-dev"]).toBe("./bin/p-dev.js");
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.repository.directory).toBe("packages/p-dev");
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        "bin",
        "dist",
        "gui",
        "templates",
        "workspace-snapshot",
        "README.md",
        "LICENSE",
      ]),
    );
    expect(manifest.dependencies["posthog-node"]).toBeDefined();
  });
});
