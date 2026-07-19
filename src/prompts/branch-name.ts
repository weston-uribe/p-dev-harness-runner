import { DEFAULT_IMPLEMENTATION_BRANCH_PREFIX } from "../config/defaults.js";
import type { HarnessConfig } from "../config/types.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildBranchName(
  issueKey: string,
  title: string,
  config: HarnessConfig,
): string {
  const prefix =
    config.implementation?.branchPrefix ?? DEFAULT_IMPLEMENTATION_BRANCH_PREFIX;
  const key = issueKey.toLowerCase();
  const slug = slugify(title);
  return slug ? `${prefix}/${key}-${slug}` : `${prefix}/${key}`;
}
