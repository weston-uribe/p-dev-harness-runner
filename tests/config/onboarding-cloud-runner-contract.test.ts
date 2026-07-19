import { describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../../src/config/schema.js";
import {
  checkCloudConfigFingerprint,
  fingerprintHarnessConfigBytes,
} from "../../src/config/cloud-config-fingerprint.js";
import { resolveLinearAssociationForIssue } from "../../src/config/resolve-linear-workspace.js";
import { resolveTargetRepo } from "../../src/resolver/target-repo.js";
import { buildRequestedHarnessConfig } from "../../src/setup/linear-workspace-plan.js";
import { parseIssueDescription } from "../../src/linear/parser.js";
import { runAuthoritativeCanonicalWorkflowGate } from "../../src/workflow/canonical-workflow-gate.js";
import { generateHarnessConfigJsonB64 as encodeConfigB64 } from "../../src/setup/harness-secret-setup.js";

describe("onboarding → cloud → runner association contract", () => {
  it("routes a FRE-1-equivalent issue after Step 2 associations are snapshotted", async () => {
    const current = harnessConfigSchema.parse({
      version: 1,
      repos: [
        {
          id: "portfolio",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          baseBranch: "dev",
        },
      ],
      allowedTargetRepos: [
        "https://github.com/weston-uribe/weston-uribe-portfolio",
      ],
    });

    // Step 2 association → local canonical config
    const localConfig = buildRequestedHarnessConfig({
      current,
      workspaceId: "ws-fresh",
      requestedAssociations: [
        {
          workspaceId: "ws-fresh",
          teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
          teamKey: "FRE",
          teamName: "fresh p-dev linear team",
          projectId: "63125fbb-f05a-43de-8496-c8a798e39f6b",
          projectName: "harness",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          repoConfigId: "portfolio",
        },
      ],
    });

    expect(localConfig.repos[0]?.linearAssociations?.[0]?.teamId).toBe(
      "8f9c1260-364b-4d3e-9aa2-0391767d5204",
    );
    expect(localConfig.linear?.teamId).toBe(
      "8f9c1260-364b-4d3e-9aa2-0391767d5204",
    );

    // Cloud snapshot serialize + fingerprint variable
    const bytes = Buffer.from(`${JSON.stringify(localConfig, null, 2)}\n`, "utf8");
    const b64 = encodeConfigB64(bytes);
    const fingerprint = fingerprintHarnessConfigBytes(bytes);
    const fingerprintCheck = checkCloudConfigFingerprint({
      configJsonB64: b64,
      expectedFingerprint: fingerprint,
      enforce: true,
    });
    expect(fingerprintCheck.ok).toBe(true);

    // GHA decode
    const decoded = harnessConfigSchema.parse(
      JSON.parse(Buffer.from(b64, "base64").toString("utf8")),
    );

    // FRE-1-equivalent issue → association resolve → planning allowed to start
    const association = resolveLinearAssociationForIssue(decoded, {
      teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
      teamKey: "FRE",
      teamName: "fresh p-dev linear team",
      projectId: "63125fbb-f05a-43de-8496-c8a798e39f6b",
    });
    expect(association?.repoConfigId).toBe("portfolio");

    const parsed = parseIssueDescription(
      [
        "## Task",
        "Remove demo header",
        "",
        "## Acceptance criteria",
        "- [ ] Done",
        "",
        "## Out of scope",
        "- Unrelated redesign",
        "",
      ].join("\n"),
    );
    const resolved = resolveTargetRepo(
      parsed,
      {
        teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
        teamKey: "FRE",
        teamName: "fresh p-dev linear team",
        projectId: "63125fbb-f05a-43de-8496-c8a798e39f6b",
        projectName: "harness",
      },
      decoded,
    );
    expect(resolved.resolutionSource).toBe("association");
    expect(resolved.baseBranch).toBe("dev");

    const gate = await runAuthoritativeCanonicalWorkflowGate({
      fixturePath: "tests/fixtures/issues/valid-target-app.md",
      config: decoded,
      issue: {
        id: "issue-uuid-1",
        identifier: "FRE-1",
        title: "Remove temporary Hello, World header demo text",
        description: parsed.task,
        status: "Ready for Planning",
        projectId: "63125fbb-f05a-43de-8496-c8a798e39f6b",
        projectName: "harness",
        teamName: "fresh p-dev linear team",
        teamKey: "FRE",
        teamId: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
        url: null,
      },
    });
    expect(gate.ok).toBe(true);
  });

  it("fails closed with cloud_config_stale when fingerprints diverge", () => {
    const bytes = Buffer.from('{"version":1}', "utf8");
    const result = checkCloudConfigFingerprint({
      configJsonB64: bytes.toString("base64"),
      expectedFingerprint: "not-the-real-hash",
      enforce: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClassification).toBe("cloud_config_stale");
    }
  });
});
