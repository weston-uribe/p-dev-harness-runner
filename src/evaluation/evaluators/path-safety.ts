import { realpathSync } from "node:fs";
import path from "node:path";

export interface PathRoots {
  logDirectory: string;
  issueKey: string;
  evaluationDirectory: string;
  runDirectory: string | null;
}

export type PathSafetyResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string };

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function resolveConfinedArtifactPath(
  artifactPath: string,
  roots: PathRoots,
): PathSafetyResult {
  if (!artifactPath || typeof artifactPath !== "string") {
    return { ok: false, reason: "empty_path" };
  }
  if (path.isAbsolute(artifactPath)) {
    return { ok: false, reason: "absolute_path_rejected" };
  }
  if (
    artifactPath.includes("\0") ||
    artifactPath.split(/[/\\]/).includes("..")
  ) {
    return { ok: false, reason: "path_traversal_rejected" };
  }

  const candidates: string[] = [];
  if (roots.runDirectory) {
    candidates.push(path.resolve(roots.runDirectory, artifactPath));
  }
  candidates.push(path.resolve(roots.evaluationDirectory, artifactPath));
  const issueRoot = path.resolve(roots.logDirectory, roots.issueKey);
  candidates.push(path.resolve(issueRoot, artifactPath));

  const allowedRoots = [
    tryRealpath(roots.evaluationDirectory),
    tryRealpath(issueRoot),
  ];
  if (roots.runDirectory) {
    allowedRoots.push(tryRealpath(roots.runDirectory));
  }

  for (const candidate of candidates) {
    const resolved = tryRealpath(candidate);
    const underRoot = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (underRoot) {
      return { ok: true, absolutePath: resolved };
    }
  }
  return { ok: false, reason: "path_outside_allowed_roots" };
}
