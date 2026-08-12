export interface DoctorCheckResult {
  label: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
}

export type DoctorCheckGroup =
  | "configuration"
  | "linear"
  | "cursor"
  | "github"
  | "filesystem";

export interface DoctorCheckGroupSummary {
  group: DoctorCheckGroup;
  checks: DoctorCheckResult[];
}

const GROUP_RULES: Array<{
  group: DoctorCheckGroup;
  match: (label: string) => boolean;
}> = [
  {
    group: "configuration",
    match: (label) =>
      label.includes("harness config") ||
      label.includes("allowedTargetRepos") ||
      label.includes("harness.config.json"),
  },
  {
    group: "filesystem",
    match: (label) => label.includes("runs/ directory writable"),
  },
  {
    group: "linear",
    match: (label) => label.startsWith("LINEAR_API_KEY"),
  },
  {
    group: "cursor",
    match: (label) =>
      label.startsWith("CURSOR_API_KEY") ||
      label.startsWith("Cursor models.list") ||
      label.startsWith("Cursor repositories.list"),
  },
  {
    group: "github",
    match: (label) =>
      label.startsWith("GITHUB_TOKEN") ||
      label.includes("base branch exists") ||
      label.includes("PR head-branch write") ||
      label.includes("target workflow") ||
      label.includes("Harness dispatch repository"),
  },
];

export function summarizeDoctorChecks(
  checks: DoctorCheckResult[],
): DoctorCheckGroupSummary[] {
  const grouped = new Map<DoctorCheckGroup, DoctorCheckResult[]>();

  for (const check of checks) {
    const group =
      GROUP_RULES.find((rule) => rule.match(check.label))?.group ?? "configuration";
    const existing = grouped.get(group) ?? [];
    existing.push(check);
    grouped.set(group, existing);
  }

  const order: DoctorCheckGroup[] = [
    "configuration",
    "filesystem",
    "linear",
    "cursor",
    "github",
  ];

  return order
    .filter((group) => grouped.has(group))
    .map((group) => ({
      group,
      checks: grouped.get(group) ?? [],
    }));
}

export function doctorChecksFailed(checks: DoctorCheckResult[]): boolean {
  return checks.some((check) => !check.ok && !check.skipped);
}

export function formatDoctorCheckLine(check: DoctorCheckResult): string {
  const icon = check.skipped ? "○" : check.ok ? "✓" : "✗";
  const suffix = check.detail ? ` — ${check.detail}` : "";
  return `${icon} ${check.label}${suffix}`;
}

export function formatDoctorCheckLines(checks: DoctorCheckResult[]): string[] {
  return checks.map(formatDoctorCheckLine);
}
