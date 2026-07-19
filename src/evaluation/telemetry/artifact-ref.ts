import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactKind, ArtifactRef, RedactionStatus } from "./types.js";

export async function buildArtifactRef(params: {
  runDirectory: string;
  absolutePath: string;
  artifactKind: ArtifactKind;
  redactionStatus?: RedactionStatus;
}): Promise<ArtifactRef | null> {
  try {
    const [content, info] = await Promise.all([
      readFile(params.absolutePath),
      stat(params.absolutePath),
    ]);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relative = path.relative(params.runDirectory, params.absolutePath);
    return {
      artifactKind: params.artifactKind,
      artifactPath: relative.split(path.sep).join("/"),
      sha256,
      byteCount: info.size,
      redactionStatus: params.redactionStatus ?? "reference_only",
    };
  } catch {
    return null;
  }
}

export function buildArtifactRefFromContent(params: {
  artifactKind: ArtifactKind;
  artifactPath: string;
  content: string | Buffer;
  redactionStatus?: RedactionStatus;
}): ArtifactRef {
  const buf = Buffer.isBuffer(params.content)
    ? params.content
    : Buffer.from(params.content, "utf8");
  return {
    artifactKind: params.artifactKind,
    artifactPath: params.artifactPath,
    sha256: createHash("sha256").update(buf).digest("hex"),
    byteCount: buf.byteLength,
    redactionStatus: params.redactionStatus ?? "reference_only",
  };
}
