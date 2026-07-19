import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_PUBLIC_LOG_FIELD_NAMES,
  type PublicSafeLogRecord,
} from "../../src/public-execution/allowed-fields.js";
import {
  PublicSafeLogger,
  formatPublicSafeSummary,
} from "../../src/public-execution/logger.js";
import { isPublicRunnerMode } from "../../src/public-execution/mode.js";
import {
  hashOpaquePublicId,
  readPrivateRuntimeContext,
  shouldKeepIssueKeyOutOfGithubEnv,
  writePrivateRuntimeContext,
} from "../../src/public-execution/private-runtime-context.js";
import {
  PublicationRejectedError,
  assertPublicSafe,
  isPublicSafe,
} from "../../src/public-execution/redaction-validator.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("public execution modules", () => {
  describe("isPublicRunnerMode", () => {
    it("returns true for affirmative env values", () => {
      expect(isPublicRunnerMode({ P_DEV_PUBLIC_RUNNER_MODE: "1" })).toBe(true);
      expect(isPublicRunnerMode({ P_DEV_PUBLIC_RUNNER_MODE: "true" })).toBe(
        true,
      );
      expect(isPublicRunnerMode({ P_DEV_PUBLIC_RUNNER_MODE: " yes " })).toBe(
        true,
      );
    });

    it("returns false for unset or non-affirmative values", () => {
      expect(isPublicRunnerMode({})).toBe(false);
      expect(isPublicRunnerMode({ P_DEV_PUBLIC_RUNNER_MODE: "0" })).toBe(false);
      expect(isPublicRunnerMode({ P_DEV_PUBLIC_RUNNER_MODE: "false" })).toBe(
        false,
      );
    });
  });

  describe("assertPublicSafe", () => {
    it("rejects issue keys, github urls, and tokens", () => {
      expect(() => assertPublicSafe("run blocked for TT-7")).toThrow(
        PublicationRejectedError,
      );
      expect(() =>
        assertPublicSafe(
          "https://github.com/weston-uribe/weston-uribe-portfolio",
        ),
      ).toThrow(PublicationRejectedError);
      expect(() =>
        assertPublicSafe("https://github.com/org/repo/pull/45"),
      ).toThrow(PublicationRejectedError);
      expect(() => assertPublicSafe("token ghp_1234567890abcdef")).toThrow(
        PublicationRejectedError,
      );
      expect(() =>
        assertPublicSafe("token github_pat_11ABCDEF1234567890"),
      ).toThrow(PublicationRejectedError);
      expect(() => assertPublicSafe("model sk-abc123")).toThrow(
        PublicationRejectedError,
      );
      expect(() => assertPublicSafe("Authorization Bearer secret.token")).toThrow(
        PublicationRejectedError,
      );
    });

    it("accepts opaque ids", () => {
      const safeValues = [
        "4a2b019f12eee7b13bc5bba1ee626e5c",
        "request-0194f2a8-7b1d-7c3e-9f0a-123456789abc",
        "phase:plan_review",
        "outcome:success",
        "durationBucket:lt_10s",
      ];

      for (const value of safeValues) {
        expect(isPublicSafe(value)).toBe(true);
        expect(() => assertPublicSafe(value)).not.toThrow();
      }
    });
  });

  describe("PublicSafeLogger", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("strips unknown fields before logging", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = new PublicSafeLogger();
      const record: PublicSafeLogRecord & Record<string, unknown> = {
        phase: "dispatch",
        outcome: "success",
        issueKey: "TT-7",
        targetRepo: "weston-uribe/weston-uribe-portfolio",
        prNumber: 45,
      };

      logger.log(record);

      expect(consoleSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
      expect(logged).toEqual({
        phase: "dispatch",
        outcome: "success",
      });
      expect(logged.issueKey).toBeUndefined();
      expect(logged.targetRepo).toBeUndefined();
      expect(logged.prNumber).toBeUndefined();
    });

    it("rejects allowlisted fields that contain issue keys", () => {
      const logger = new PublicSafeLogger();
      expect(() =>
        logger.log({
          phase: "plan_review for TT-7",
          outcome: "failure",
        }),
      ).toThrow(PublicationRejectedError);
    });

    it("formats step summaries from allowlisted fields only", () => {
      const summary = formatPublicSafeSummary({
        phase: "dispatch",
        outcome: "noop",
        requestId: "4a2b019f12eee7b13bc5bba1ee626e5c",
        noops: 1,
      });

      expect(summary).toContain("## Public execution summary");
      expect(summary).toContain("**phase**: dispatch");
      expect(summary).toContain("**outcome**: noop");
      expect(summary).not.toContain("issueKey");
    });
  });

  describe("private runtime context", () => {
    it("keeps issue keys out of GITHUB_ENV in public mode", () => {
      expect(
        shouldKeepIssueKeyOutOfGithubEnv({ P_DEV_PUBLIC_RUNNER_MODE: "1" }),
      ).toBe(true);
      expect(shouldKeepIssueKeyOutOfGithubEnv({})).toBe(false);
    });

    it("persists private fields to a local context file", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "p-dev-private-ctx-"));
      const contextPath = path.join(dir, "runtime-context.json");
      try {
        const env = {
          P_DEV_PRIVATE_RUNTIME_CONTEXT_PATH: contextPath,
        };
        writePrivateRuntimeContext(
          {
            issueKey: "TT-10",
            repoConfigId: "weston-uribe-portfolio",
            mergeConcurrencyGroup: "weston-uribe-portfolio-dev",
          },
          env,
        );
        expect(readPrivateRuntimeContext(env)).toEqual({
          issueKey: "TT-10",
          repoConfigId: "weston-uribe-portfolio",
          mergeConcurrencyGroup: "weston-uribe-portfolio-dev",
        });
        expect(hashOpaquePublicId("weston-uribe-portfolio-dev")).toMatch(
          /^[a-f0-9]{32}$/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("deliberate leakage summaries", () => {
    const leakageSummaries = [
      "Workflow run for TT-7 failed during dispatch.",
      "Target repository weston-uribe/weston-uribe-portfolio on github.com is unavailable.",
      "See https://github.com/weston-uribe/weston-uribe-portfolio/pull/45 for PR #45.",
      "Reviewer finding text referenced sk-leaked-token.",
      "Reviewer source snippet included Bearer leaked.jwt.token",
      "Authentication failed with ghp_xxx",
    ] as const;

    it("fails closed on chunk8 regression leakage markers", () => {
      for (const summary of leakageSummaries) {
        expect(isPublicSafe(summary)).toBe(false);
        expect(() => assertPublicSafe(summary)).toThrow(
          PublicationRejectedError,
        );
      }
    });

    it("documents the allowlisted public log field contract", () => {
      expect(ALLOWED_PUBLIC_LOG_FIELD_NAMES).toContain("requestId");
      expect(ALLOWED_PUBLIC_LOG_FIELD_NAMES).toContain("outcome");
      expect(ALLOWED_PUBLIC_LOG_FIELD_NAMES).not.toContain("issueKey");
    });
  });
});
