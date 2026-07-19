/**
 * Canonical skill package discovery and validation under .agents/skills only.
 * Production must not generate or require .cursor/skills mirrors.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const CANONICAL_SKILLS_DIR = ".agents/skills" as const;

export interface SkillFrontmatter {
  name: string;
  description: string;
  skillContractVersion: string | null;
}

export interface SkillPackage {
  skillId: string;
  sourcePath: string;
  absolutePath: string;
  contentSha256: string;
  frontmatter: SkillFrontmatter;
  byteCount: number;
  valid: boolean;
  errors: string[];
}

export interface SkillDiscoveryResult {
  root: string;
  packages: SkillPackage[];
  errors: string[];
}

const FORBIDDEN_PATH_PATTERNS = [
  /\/Users\//i,
  /\/home\//i,
  /[A-Z]:\\/i,
  /process\.env\./,
  /CURSOR_API_KEY|LINEAR_API_KEY|GITHUB_TOKEN|LANGFUSE_SECRET/i,
];

function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  errors: string[];
} {
  const errors: string[] = [];
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    errors.push("Missing YAML frontmatter delimited by ---");
    return {
      frontmatter: {
        name: "",
        description: "",
        skillContractVersion: null,
      },
      errors,
    };
  }
  const block = match[1] ?? "";
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const versionMatch = block.match(
    /^skillContractVersion:\s*["']?([^\s"']+)/m,
  );

  let description = "";
  const foldedDesc = block.match(
    /^description:\s*>-?\s*\n((?:[ \t]+.+\n?)*)/m,
  );
  const inlineDesc = block.match(/^description:\s*(.+)$/m);
  if (foldedDesc?.[1]) {
    description = foldedDesc[1]
      .split("\n")
      .map((l) => l.replace(/^\s+/, "").replace(/\s+$/, ""))
      .filter(Boolean)
      .join(" ")
      .trim();
  } else if (inlineDesc?.[1] && !inlineDesc[1].startsWith(">")) {
    description = inlineDesc[1].trim().replace(/^["']|["']$/g, "");
  }

  const name = (nameMatch?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!name) errors.push("frontmatter.name is required");
  if (!description) errors.push("frontmatter.description is required");

  return {
    frontmatter: {
      name,
      description,
      skillContractVersion: versionMatch?.[1] ?? null,
    },
    errors,
  };
}

function validateContent(content: string, skillId: string): string[] {
  const errors: string[] = [];
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(
        `Skill ${skillId} appears to contain environment-specific paths or secrets matching ${pattern}`,
      );
    }
  }
  if (!content.includes("# ")) {
    errors.push(`Skill ${skillId} should include a markdown heading`);
  }
  return errors;
}

export async function loadSkillPackage(
  absoluteSkillMdPath: string,
  repoRoot: string,
): Promise<SkillPackage> {
  const sourcePath = path
    .relative(repoRoot, absoluteSkillMdPath)
    .split(path.sep)
    .join("/");
  const errors: string[] = [];
  let content = "";
  try {
    content = await readFile(absoluteSkillMdPath, "utf8");
  } catch (err) {
    return {
      skillId: path.basename(path.dirname(absoluteSkillMdPath)),
      sourcePath,
      absolutePath: absoluteSkillMdPath,
      contentSha256: "",
      frontmatter: {
        name: "",
        description: "",
        skillContractVersion: null,
      },
      byteCount: 0,
      valid: false,
      errors: [
        `Failed to read skill: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const { frontmatter, errors: fmErrors } = parseFrontmatter(content);
  errors.push(...fmErrors);
  errors.push(...validateContent(content, frontmatter.name || sourcePath));

  const skillId =
    frontmatter.name || path.basename(path.dirname(absoluteSkillMdPath));
  if (frontmatter.name && frontmatter.name !== path.basename(path.dirname(absoluteSkillMdPath))) {
    errors.push(
      `frontmatter.name "${frontmatter.name}" must match directory name "${path.basename(path.dirname(absoluteSkillMdPath))}"`,
    );
  }

  if (!sourcePath.startsWith(`${CANONICAL_SKILLS_DIR}/`)) {
    errors.push(
      `Production skills must live under ${CANONICAL_SKILLS_DIR}/ (got ${sourcePath})`,
    );
  }

  return {
    skillId,
    sourcePath,
    absolutePath: absoluteSkillMdPath,
    contentSha256,
    frontmatter,
    byteCount: Buffer.byteLength(content, "utf8"),
    valid: errors.length === 0,
    errors,
  };
}

export async function discoverCanonicalSkills(
  repoRoot: string = process.cwd(),
): Promise<SkillDiscoveryResult> {
  const root = path.resolve(repoRoot);
  const skillsDir = path.join(root, CANONICAL_SKILLS_DIR);
  const errors: string[] = [];
  const packages: SkillPackage[] = [];

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (err) {
    return {
      root,
      packages: [],
      errors: [
        `Canonical skills directory missing: ${skillsDir} (${err instanceof Error ? err.message : String(err)})`,
      ],
    };
  }

  for (const entry of entries.sort()) {
    const dir = path.join(skillsDir, entry);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const skillMd = path.join(dir, "SKILL.md");
    const pkg = await loadSkillPackage(skillMd, root);
    packages.push(pkg);
    if (!pkg.valid) errors.push(...pkg.errors.map((e) => `${entry}: ${e}`));
  }

  return { root, packages, errors };
}

export async function assertNoProductionCursorSkillsMirror(
  repoRoot: string = process.cwd(),
): Promise<{ ok: boolean; message: string }> {
  const cursorSkills = path.join(repoRoot, ".cursor", "skills");
  try {
    const st = await stat(cursorSkills);
    if (st.isDirectory()) {
      const entries = await readdir(cursorSkills);
      if (entries.length > 0) {
        return {
          ok: false,
          message: `.cursor/skills exists with entries [${entries.join(", ")}] — production secondary layouts are forbidden until Cloud Agent canary proves a required layout`,
        };
      }
    }
  } catch {
    // absent is expected
  }
  return { ok: true, message: "No production .cursor/skills mirror present" };
}

export function contentSha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
