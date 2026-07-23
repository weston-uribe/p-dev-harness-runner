import { describe, expect, it } from "vitest";
import {
  buildErrorCommentBody,
  formatHarnessCommentFooter,
  formatPhaseStartComment,
  formatPlanningComment,
} from "../../src/linear/comments.js";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";
import { toPublicProviderIdentityHashes } from "../../src/linear/provider-identity-public.js";

const SENTINEL = "SENTINEL_RAW_PROVIDER_AGENT_ID_bc-test-never-real";
const ORCHESTRATOR = "harness-orchestrator-v1";
const TARGET_REPO = "https://github.com/owner/example-target-app";

function assertSentinelNeverLeaks(output: string, expectedHash: string): void {
  expect(output).not.toContain(SENTINEL);
  expect(output).toContain(`cursor_agent_id_hash: ${expectedHash}`);
  expect(output).toContain(`cursor_run_id_hash: ${expectedHash}`);
  expect(output).not.toContain("cursor_agent_id:");
  expect(output).not.toContain("cursor_run_id:");
  expect(output).not.toMatch(
    new RegExp(`cursor\\.cloud[^\\n]*${SENTINEL}`, "i"),
  );
  expect(output).not.toMatch(
    new RegExp(`agents\\.cursor[^\\n]*${SENTINEL}`, "i"),
  );
}

describe("public provider identity sentinel", () => {
  it("never leaks raw sentinel ids through public comment formatters", () => {
    const expectedHash = hashProviderIdentity(SENTINEL);
    const hashes = toPublicProviderIdentityHashes({
      cursorAgentId: SENTINEL,
      cursorRunId: SENTINEL,
    });
    expect(hashes.cursorAgentIdHash).toBe(expectedHash);
    expect(hashes.cursorRunIdHash).toBe(expectedHash);

    const footer = {
      orchestratorMarker: ORCHESTRATOR,
      phase: "planning",
      runId: "2026-07-06T20-30-00Z-WES-11",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: TARGET_REPO,
      baseBranch: "main",
      ...hashes,
    };

    const phaseStart = formatPhaseStartComment(
      "planning_start",
      {
        issueKey: "WES-11",
        targetRepo: TARGET_REPO,
        baseBranch: "main",
      },
      footer,
    );
    const planning = formatPlanningComment(
      "## Plan\n\nStep 1",
      footer,
      { planningOnlyTerminal: true },
    );
    const errorBody = buildErrorCommentBody("planning", "Planning failed", {
      targetRepo: TARGET_REPO,
      baseBranch: "main",
      harnessRunId: footer.runId,
      errorClassification: "configuration_error",
    });
    const errorComment = `${errorBody}\n\n${formatHarnessCommentFooter(footer)}`;

    for (const output of [phaseStart, planning, errorComment]) {
      assertSentinelNeverLeaks(output, expectedHash);
    }
  });
});
