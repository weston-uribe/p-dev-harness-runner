export interface HarnessCommentLink {
  label: string;
  url: string;
}

export interface HarnessCommentCardInput {
  phaseLabel: string;
  pmSection?: string[];
  engineerSection?: string[];
  footer: string;
}

export function formatLinksAsMarkdown(links: HarnessCommentLink[]): string[] {
  return links.map((link) => `- [${link.label}](${link.url})`);
}

export function buildHarnessComment(input: HarnessCommentCardInput): string {
  const lines = [
    "# Comment from harness",
    "",
    `**Phase:** ${input.phaseLabel}`,
    "",
    "## For the PM",
  ];

  if (input.pmSection && input.pmSection.length > 0) {
    lines.push(...input.pmSection);
  }

  lines.push("", "---", "", "## For the engineer");

  if (input.engineerSection && input.engineerSection.length > 0) {
    lines.push(...input.engineerSection);
  }

  if (input.footer) {
    lines.push("", input.footer);
  }
  return lines.join("\n");
}

export interface MinimalHarnessCommentInput {
  phaseLabel: string;
  links?: HarnessCommentLink[];
  note?: string;
  footer?: string;
}

/** Phase-start comments with links only — no PM/engineer sections. */
export function buildMinimalHarnessComment(
  input: MinimalHarnessCommentInput,
): string {
  const lines = ["# Comment from harness", "", `**Phase:** ${input.phaseLabel}`, ""];

  if (input.links && input.links.length > 0) {
    lines.push(...formatLinksAsMarkdown(input.links));
  }
  if (input.note) {
    lines.push("", input.note);
  }
  if (input.footer) {
    lines.push("", input.footer);
  }
  return lines.join("\n");
}

/** Strips HTML comments so tests can assert visible markdown only. */
export function getVisibleCommentBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function formatBulletList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}
