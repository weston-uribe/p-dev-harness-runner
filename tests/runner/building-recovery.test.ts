import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_IN_PROGRESS_STALE_MS,
  isImplementationStartStale,
  parseRunIdTimestamp,
} from "../../src/runner/building-recovery.js";

describe("building recovery helpers", () => {
  it("parses harness run id timestamps", () => {
    const parsed = parseRunIdTimestamp("2026-07-08T02-49-25-188Z-WES-22");
    expect(parsed?.toISOString()).toBe("2026-07-08T02:49:25.000Z");
  });

  it("treats fresh implementation_start markers as in progress", () => {
    const now = Date.parse("2026-07-08T02:50:00.000Z");
    expect(
      isImplementationStartStale("2026-07-08T02-49-25-188Z-WES-22", now),
    ).toBe(false);
  });

  it("treats stale implementation_start markers as recoverable", () => {
    const now =
      Date.parse("2026-07-08T02:49:25.000Z") +
      IMPLEMENTATION_IN_PROGRESS_STALE_MS +
      1;
    expect(
      isImplementationStartStale("2026-07-08T02-49-25-188Z-WES-22", now),
    ).toBe(true);
  });
});
