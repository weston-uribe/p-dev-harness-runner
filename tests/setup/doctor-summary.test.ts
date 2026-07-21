import { describe, expect, it } from "vitest";
import {
  doctorChecksDegraded,
  doctorChecksFailed,
  formatDoctorCheckLine,
  resolveDoctorCheckSeverity,
  sanitizeDoctorFailedChecks,
  summarizeDoctorChecks,
  summarizeDoctorChecksBySeverity,
} from "../../src/setup/doctor-summary.js";

describe("doctor-summary", () => {
  const checks = [
    { label: "harness config valid", ok: true, detail: ".harness/config.local.json" },
    { label: "LINEAR_API_KEY set", ok: true, detail: "authenticated as Operator" },
    {
      label: "CURSOR_API_KEY set",
      ok: true,
      skipped: true,
      detail: "required only when merge integration repair needs a Cursor agent",
    },
    { label: "target-app base branch exists", ok: false, detail: "missing branch" },
  ];

  it("groups checks by provider area", () => {
    const groups = summarizeDoctorChecks(checks);

    expect(groups.map((group) => group.group)).toEqual([
      "configuration",
      "linear",
      "cursor",
      "github",
    ]);
  });

  it("preserves pass, fail, and skipped formatting", () => {
    expect(formatDoctorCheckLine(checks[0]!)).toBe(
      "✓ harness config valid — .harness/config.local.json",
    );
    expect(formatDoctorCheckLine(checks[2]!)).toContain("○ CURSOR_API_KEY set");
    expect(formatDoctorCheckLine(checks[3]!)).toContain("✗ target-app base branch exists");
  });

  it("detects critical failures while ignoring skipped and passing critical labels", () => {
    expect(doctorChecksFailed(checks)).toBe(true);
    expect(
      doctorChecksFailed([
        { label: "CURSOR_API_KEY set", ok: true, skipped: true },
      ]),
    ).toBe(false);
    expect(
      doctorChecksFailed([
        {
          label: "GITHUB_DISPATCH_TOKEN set",
          ok: true,
          severity: "critical",
        },
      ]),
    ).toBe(false);
  });

  it("treats explicit degraded failures as non-blocking for phase exit", () => {
    const degraded = {
      label: "Reconcile heartbeat fresh",
      ok: false,
      severity: "degraded" as const,
      classification: "reconcile_heartbeat_stale",
      detail: "Heartbeat is 100m old",
    };
    expect(resolveDoctorCheckSeverity(degraded)).toBe("degraded");
    expect(doctorChecksFailed([degraded])).toBe(false);
    expect(doctorChecksDegraded([degraded])).toBe(true);
    expect(formatDoctorCheckLine(degraded)).toContain("⚠ Reconcile heartbeat fresh");
  });

  it("summarizes severity tallies and sanitizes failed checks", () => {
    const mixed = [
      { label: "harness config valid", ok: true },
      {
        label: "Reconcile heartbeat fresh",
        ok: false,
        severity: "degraded" as const,
        classification: "reconcile_heartbeat_stale",
      },
      {
        label: "GITHUB_TOKEN set",
        ok: false,
        severity: "critical" as const,
        classification: "missing_github_token",
      },
      { label: "CURSOR_API_KEY set", ok: true, skipped: true },
    ];
    const tallies = summarizeDoctorChecksBySeverity(mixed);
    expect(tallies.passed).toBe(1);
    expect(tallies.degraded).toBe(1);
    expect(tallies.critical).toBe(1);
    expect(tallies.skipped).toBe(1);

    const sanitized = sanitizeDoctorFailedChecks(mixed);
    expect(sanitized).toEqual([
      {
        label: "Reconcile heartbeat fresh",
        severity: "degraded",
        classification: "reconcile_heartbeat_stale",
        blockedPhase: false,
      },
      {
        label: "GITHUB_TOKEN set",
        severity: "critical",
        classification: "missing_github_token",
        blockedPhase: true,
      },
    ]);
  });
});
