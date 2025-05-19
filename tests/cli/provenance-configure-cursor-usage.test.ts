import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../src/evaluation/cursor-usage-import/provenance-scope/active-epoch-resolver.js",
  () => ({
    resolveAuthoritativeActiveEpoch: vi.fn(async () => ({
      privatePin: {
        stateRepository: "weston-uribe/p-dev-harness-state",
        stateBranch: "p-dev-runtime-state",
        registrySnapshotCommitSha: "1d913479d460bd675a0f9a3e2115f5308bae053e",
        activationCommitSha: "844809a95a70a4f8cb1033f21b3cf6cb234e22ec",
        historyProofCommitSha: "d7bc6e088bb31ead4b273bb358e93272e3fa4b8e",
        coverageSnapshotCommitSha: "78a12ba1a6520ff6a087493b94d59cb304484f86",
        sealCommitSha: "95cbaed4838e7e212ab0cd170a4ceba04dc885b0",
        verifiedStateTip: "abc",
        epochId: "live-rollout-2026-07-24-required-repair-1",
        interval: {
          coverageStart: "2026-07-24T04:49:52.000Z",
          coverageEnd: "2026-07-24T04:59:52.000Z",
        },
        finalizationPolicyDigest: null,
        sealDigest: "fa2ccbd0e6692ca3eea7c77e4fc4b83a3cc5916e8be787eea200c65c6b99ee6b",
        rowSelectionTemporalPolicyVersion: "1",
        rowSelectionTemporalPolicyDigest: "aa".repeat(32),
      },
      publicView: {
        provenanceConfigured: true,
        runnerMode: "required",
        verificationStatus: "sealed_complete",
        coverageEligibilityStatus: "sealed_complete_no_importable_csv_window",
        activeEpochId: "live-rollout-2026-07-24-required-repair-1",
        sealedInterval: {
          coverageStart: "2026-07-24T04:49:52.000Z",
          coverageEnd: "2026-07-24T04:59:52.000Z",
        },
        eligibleCsvRowInterval: {
          startInclusive: null,
          endExclusive: null,
          latestInclusive: null,
          empty: true,
          policyVersion: "1",
          policyDigest: "aa".repeat(32),
        },
        eligibleCsvRowIntervalEmpty: true,
        absenceBasedExclusionAuthorized: true,
        officialCsvPreflightRunnable: false,
        officialCsvApplyPossible: false,
        activationDigestPrefix: null,
        coverageDigestPrefix: null,
        sealDigestPrefix: "fa2ccbd0e669",
        unresolvedOrGapCount: 0,
        postSealFullyEnumerated: true,
        postSealInvalidatingCount: 0,
        failureReason: null,
        actionableInstruction: null,
        exportGuidance: "empty",
      },
      inspection: null,
      liveRunner: null,
      registryPin: null,
    })),
  }),
);

vi.mock(
  "../../src/evaluation/cursor-usage-import/provenance-scope/live-runner-status.js",
  () => ({
    resolveLiveRunnerPublicStatus: vi.fn(async () => ({
      runnerRepository: "weston-uribe/p-dev-harness-runner",
      runnerMode: "required",
      runnerModeSource: "actions_variable",
      keySecretConfigured: true,
      runnerMainSha: "904107800e040f84d1a0368277cde98a2e21f1e2",
      packagedSourceSha: "f8b2d6bd4c0f98e5cb49a9fcf76211f5a8c1d525",
      localModeDiagnostic: null,
      failureReason: null,
    })),
  }),
);

import { runConfigureCursorUsageCommand } from "../../src/cli/commands/provenance-configure-cursor-usage.js";

describe("configure-cursor-usage", () => {
  const temps: string[] = [];
  afterEach(async () => {
    // leave temps; hermetic env cleanup is enough
  });

  async function makeWorkspace(extra = "") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-configure-"));
    temps.push(dir);
    const content = `# comment keep
GITHUB_TOKEN=secret-github-token-value
LANGFUSE_SECRET_KEY=secret-langfuse
CURSOR_API_KEY=secret-cursor
P_DEV_STATE_GITHUB_TOKEN=secret-state-token
HARNESS_GITHUB_TOKEN=secret-harness-token
P_DEV_PROVENANCE_KEY_V1=secret-provenance-key
UNKNOWN_SECRET_LOOKING_VALUE=keep-me-byte-exact
P_DEV_WORKFLOW_STATE_REPOSITORY=weston-uribe/p-dev-harness-state
UNRELATED_SETTING=hello
${extra}`;
    await writeFile(path.join(dir, ".env.local"), content, {
      encoding: "utf8",
      mode: 0o644,
    });
    return { dir, content };
  }

  it("check mode performs zero writes", async () => {
    const { dir, content } = await makeWorkspace();
    const before = await readFile(path.join(dir, ".env.local"), "utf8");
    const code = await runConfigureCursorUsageCommand({
      workspace: dir,
      check: true,
    });
    expect(code).toBe(0);
    const after = await readFile(path.join(dir, ".env.local"), "utf8");
    expect(after).toBe(before);
    expect(after).toBe(content);
  });

  it("preserves secrets byte-for-byte and updates only selectors", async () => {
    const { dir, content } = await makeWorkspace();
    const code = await runConfigureCursorUsageCommand({
      workspace: dir,
      activeEpoch: "live-rollout-2026-07-24-required-repair-1",
    });
    expect(code).toBe(0);
    const after = await readFile(path.join(dir, ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      if (
        line.includes("GITHUB_TOKEN=") ||
        line.includes("LANGFUSE_SECRET_KEY=") ||
        line.includes("CURSOR_API_KEY=") ||
        line.includes("P_DEV_STATE_GITHUB_TOKEN=") ||
        line.includes("HARNESS_GITHUB_TOKEN=") ||
        line.includes("P_DEV_PROVENANCE_KEY_V1=") ||
        line.includes("UNKNOWN_SECRET_LOOKING_VALUE=") ||
        line.startsWith("#")
      ) {
        expect(after).toContain(line);
      }
    }
    expect(after).toContain("UNRELATED_SETTING=hello");
    expect(after).toContain(
      "P_DEV_PROVENANCE_ACTIVE_EPOCH_ID=live-rollout-2026-07-24-required-repair-1",
    );
    expect(after).not.toContain("P_DEV_CURSOR_PROVENANCE_MODE=");
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(path.join(dir, ".env.local"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is idempotent on repeated identical configuration", async () => {
    const { dir } = await makeWorkspace();
    await runConfigureCursorUsageCommand({ workspace: dir });
    const first = await readFile(path.join(dir, ".env.local"), "utf8");
    await runConfigureCursorUsageCommand({ workspace: dir });
    const second = await readFile(path.join(dir, ".env.local"), "utf8");
    expect(second).toBe(first);
  });

  it("missing credential fails without mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-configure-nocred-"));
    await writeFile(
      path.join(dir, ".env.local"),
      "UNRELATED_SETTING=hello\n",
      "utf8",
    );
    const before = await readFile(path.join(dir, ".env.local"), "utf8");
    // Clear inherited tokens for this process env during the call
    const prev = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      HARNESS_GITHUB_TOKEN: process.env.HARNESS_GITHUB_TOKEN,
      P_DEV_STATE_GITHUB_TOKEN: process.env.P_DEV_STATE_GITHUB_TOKEN,
    };
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.P_DEV_STATE_GITHUB_TOKEN;
    try {
      const code = await runConfigureCursorUsageCommand({ workspace: dir });
      expect(code).not.toBe(0);
      const after = await readFile(path.join(dir, ".env.local"), "utf8");
      expect(after).toBe(before);
    } finally {
      if (prev.GITHUB_TOKEN) process.env.GITHUB_TOKEN = prev.GITHUB_TOKEN;
      if (prev.HARNESS_GITHUB_TOKEN)
        process.env.HARNESS_GITHUB_TOKEN = prev.HARNESS_GITHUB_TOKEN;
      if (prev.P_DEV_STATE_GITHUB_TOKEN)
        process.env.P_DEV_STATE_GITHUB_TOKEN = prev.P_DEV_STATE_GITHUB_TOKEN;
    }
  });
});
