import { createRequire } from "node:module";
import path from "node:path";

export function resolveNextBin(packageRoot: string): string {
  const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
  const nextPackageJson = requireFromPackage.resolve("next/package.json");
  return path.join(path.dirname(nextPackageJson), "dist", "bin", "next");
}
