import type { ToolMutationClass } from "./types.js";

const READ_ONLY = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "readLints",
  "semSearch",
  "await",
  "browser_snapshot",
  "browser_tabs",
]);

const MUTATION = new Set([
  "write",
  "edit",
  "delete",
  "shell",
  "createPlan",
  "updateTodos",
  "task",
  "mcp",
]);

export function classifyToolMutation(toolName: string): ToolMutationClass {
  const name = toolName.trim();
  if (READ_ONLY.has(name)) return "read_only";
  if (MUTATION.has(name)) return "mutation";
  // Heuristic: shell-like names are mutations
  if (/shell|write|edit|delete|apply/i.test(name)) return "mutation";
  if (/read|grep|glob|search|list|ls/i.test(name)) return "read_only";
  return "unknown";
}

/** Stable Langfuse observation name by tool category (not unique call id). */
export function toolObservationName(toolName: string): string {
  const category = toolName.trim().toLowerCase() || "unknown";
  return `p-dev.tool.${category}`;
}

export function extractRepoRelativePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path", "target"]) {
    if (typeof a[key] === "string" && a[key]) {
      const p = a[key] as string;
      // Prefer repo-relative; strip absolute prefixes lightly
      if (p.startsWith("/")) {
        const idx = p.indexOf("/src/");
        if (idx >= 0) return p.slice(idx + 1);
      }
      return p;
    }
  }
  return undefined;
}
