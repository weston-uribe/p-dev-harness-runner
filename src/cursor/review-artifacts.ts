/**
 * Best-effort download of Cursor Cloud agent review artifacts (e.g. plan-mode
 * leftovers). Used as a fail-closed fallback for decision extraction.
 */

import type { SDKAgent } from "@cursor/sdk";

export interface DownloadedReviewArtifact {
  path: string;
  text: string;
  sizeBytes: number;
}

function artifactEntryPath(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    const path = (entry as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return null;
}

function decodeArtifactBytes(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { content?: unknown; text?: unknown; data?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (obj.data instanceof Uint8Array) {
      return Buffer.from(obj.data).toString("utf8");
    }
  }
  return "";
}

/**
 * List and download text-like artifacts from a resumed Cursor agent.
 * Prefer plan markdown paths; return the largest text artifact when several exist.
 */
export async function downloadReviewArtifacts(
  agent: SDKAgent,
): Promise<DownloadedReviewArtifact[]> {
  const list = agent.listArtifacts?.bind(agent);
  const download = agent.downloadArtifact?.bind(agent);
  if (!list || !download) {
    return [];
  }

  let entries: unknown[];
  try {
    entries = (await list()) as unknown[];
  } catch {
    return [];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const downloaded: DownloadedReviewArtifact[] = [];
  for (const entry of entries) {
    const path = artifactEntryPath(entry);
    if (!path) continue;
    try {
      const raw = await download(path);
      const text = decodeArtifactBytes(raw);
      if (!text.trim()) continue;
      downloaded.push({
        path,
        text,
        sizeBytes: Buffer.byteLength(text, "utf8"),
      });
    } catch {
      // best-effort per artifact
    }
  }

  // Prefer plan markdown for FRE-8-shaped leftovers.
  downloaded.sort((a, b) => {
    const aPlan = a.path.includes(".plan.md") || a.path.includes("/plans/") ? 0 : 1;
    const bPlan = b.path.includes(".plan.md") || b.path.includes("/plans/") ? 0 : 1;
    if (aPlan !== bPlan) return aPlan - bPlan;
    return b.sizeBytes - a.sizeBytes;
  });
  return downloaded;
}

export function selectPrimaryReviewArtifact(
  artifacts: DownloadedReviewArtifact[],
): DownloadedReviewArtifact | null {
  return artifacts[0] ?? null;
}
