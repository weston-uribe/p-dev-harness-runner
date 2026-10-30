import { describe, expect, it } from "vitest";
import type { HarnessCommentFooterInput } from "../../src/linear/comments.js";
import { formatHarnessCommentFooter } from "../../src/linear/comments.js";
import { hashProviderIdentity } from "../../src/identity/provider-identity-hash.js";
import { toPublicProviderIdentityHashes } from "../../src/linear/provider-identity-public.js";

describe("HarnessCommentFooterInput public identity boundary", () => {
  it("uses hash-only provider identity keys on constructed footer objects", () => {
    const rawAgentId = "bc-agent-never-public";
    const rawRunId = "run-never-public";
    const hashes = toPublicProviderIdentityHashes({
      cursorAgentId: rawAgentId,
      cursorRunId: rawRunId,
    });

    const footer: HarnessCommentFooterInput = {
      orchestratorMarker: "harness-orchestrator-v1",
      phase: "planning",
      runId: "run-1",
      model: "composer-2.5",
      promptVersion: "planning@1",
      targetRepo: "https://github.com/owner/example-target-app",
      ...hashes,
    };

    const keys = Object.keys(footer);
    expect(keys).not.toContain("cursorAgentId");
    expect(keys).not.toContain("cursorRunId");
    expect(keys).not.toContain("builderAgentId");
    expect(keys).not.toContain("previousBuilderAgentId");
    expect(footer.cursorAgentIdHash).toBe(hashProviderIdentity(rawAgentId));
    expect(footer.cursorRunIdHash).toBe(hashProviderIdentity(rawRunId));

    const rendered = formatHarnessCommentFooter(footer);
    expect(rendered).toContain(
      `cursor_agent_id_hash: ${hashProviderIdentity(rawAgentId)}`,
    );
    expect(rendered).not.toContain(rawAgentId);
    expect(rendered).not.toContain(rawRunId);
    expect(rendered).not.toContain("cursor_agent_id:");
    expect(rendered).not.toContain("cursor_run_id:");
  });
});
