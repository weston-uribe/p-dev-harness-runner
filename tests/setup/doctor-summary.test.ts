import { describe, expect, it } from "vitest";
import {
  doctorChecksFailed,
  formatDoctorCheckLine,
  summarizeDoctorChecks,
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

  it("detects failed checks while ignoring skipped checks", () => {
    expect(doctorChecksFailed(checks)).toBe(true);
    expect(
      doctorChecksFailed([
        { label: "CURSOR_API_KEY set", ok: true, skipped: true },
      ]),
    ).toBe(false);
  });
});
