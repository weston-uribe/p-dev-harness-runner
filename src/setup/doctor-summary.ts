export type DoctorCheckSeverity = "critical" | "degraded" | "informational";

export interface DoctorCheckResult {
  label: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
  /** When set, overrides default inference for exit/formatting. */
  severity?: DoctorCheckSeverity;
  /** Stable machine-readable classification for diagnostics. */
  classification?: string;
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

export interface DoctorSeverityTallies {
  critical: number;
  degraded: number;
  informational: number;
  passed: number;
  skipped: number;
}

export interface SanitizedDoctorFailedCheck {
  label: string;
  severity: DoctorCheckSeverity;
  classification: string;
  blockedPhase: boolean;
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

/**
 * Default inference when severity is omitted:
 * - skipped → informational
 * - !ok → critical (preserves historical fail-closed behavior)
 * - ok with warn: detail → degraded
 * - ok → informational
 */
export function resolveDoctorCheckSeverity(
  check: DoctorCheckResult,
): DoctorCheckSeverity {
  if (check.severity) return check.severity;
  if (check.skipped) return "informational";
  if (!check.ok) return "critical";
  if (check.detail?.startsWith("warn:")) return "degraded";
  return "informational";
}

/** Phase profiles fail only on critical severity failures (not passes). */
export function doctorChecksFailed(checks: DoctorCheckResult[]): boolean {
  return checks.some(
    (check) =>
      !check.ok &&
      !check.skipped &&
      resolveDoctorCheckSeverity(check) === "critical",
  );
}

export function doctorChecksDegraded(checks: DoctorCheckResult[]): boolean {
  return checks.some((check) => {
    if (check.skipped) return false;
    if (resolveDoctorCheckSeverity(check) !== "degraded") return false;
    // Failed degraded checks, or explicit warn: on an otherwise-passing check.
    return !check.ok || Boolean(check.detail?.startsWith("warn:"));
  });
}

export function summarizeDoctorChecksBySeverity(
  checks: DoctorCheckResult[],
): DoctorSeverityTallies {
  const tallies: DoctorSeverityTallies = {
    critical: 0,
    degraded: 0,
    informational: 0,
    passed: 0,
    skipped: 0,
  };
  for (const check of checks) {
    if (check.skipped) {
      tallies.skipped += 1;
      continue;
    }
    if (check.ok) {
      const severity = resolveDoctorCheckSeverity(check);
      if (severity === "degraded") {
        tallies.degraded += 1;
      } else {
        tallies.passed += 1;
      }
      continue;
    }
    const severity = resolveDoctorCheckSeverity(check);
    if (severity === "critical") tallies.critical += 1;
    else if (severity === "degraded") tallies.degraded += 1;
    else tallies.informational += 1;
  }
  return tallies;
}

export function sanitizeDoctorFailedChecks(
  checks: DoctorCheckResult[],
): SanitizedDoctorFailedCheck[] {
  return checks
    .filter((check) => !check.ok && !check.skipped)
    .map((check) => {
      const severity = resolveDoctorCheckSeverity(check);
      return {
        label: check.label.replace(/[^a-zA-Z0-9 .:_/-]/g, "").slice(0, 80),
        severity,
        classification: (
          check.classification ??
          check.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")
        ).slice(0, 64),
        blockedPhase: severity === "critical",
      };
    });
}

export function formatDoctorCheckLine(check: DoctorCheckResult): string {
  const severity = resolveDoctorCheckSeverity(check);
  let icon = "✓";
  if (check.skipped) icon = "○";
  else if (!check.ok && severity === "critical") icon = "✗";
  else if (!check.ok && severity === "degraded") icon = "⚠";
  else if (!check.ok) icon = "○";
  else if (severity === "degraded") icon = "⚠";
  const suffix = check.detail ? ` — ${check.detail}` : "";
  return `${icon} ${check.label}${suffix}`;
}

export function formatDoctorCheckLines(checks: DoctorCheckResult[]): string[] {
  return checks.map(formatDoctorCheckLine);
}
