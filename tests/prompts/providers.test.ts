import { describe, expect, it } from "vitest";
import { assembleAgentPrompt } from "../../src/prompts/assemble.js";
import { createLocalPromptProvider } from "../../src/prompts/providers/local.js";
import {
  createLangfusePromptProvider,
  type LangfusePromptClientLike,
} from "../../src/prompts/providers/langfuse.js";
import { resolvePhasePrompt } from "../../src/prompts/providers/resolve.js";
import { sha256Text } from "../../src/prompts/registry.js";
import { buildPlanningPrompt } from "../../src/prompts/builder.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import type { ParsedIssue } from "../../src/types/parsed-issue.js";
import type { ResolvedTarget } from "../../src/resolver/target-repo.js";

const issue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-11",
  title: "Hello world page",
  description: "",
  status: "Ready for Planning",
  projectName: "Example Target App",
  teamName: "WES",
  teamKey: null,
  teamId: "team-1",
  url: null,
};

const parsed: ParsedIssue = {
  task: "Add a hello world page",
  acceptanceCriteria: ["Route renders Hello World"],
  outOfScope: ["Harness changes"],
  parseErrors: [],
};

const resolved: ResolvedTarget = {
  targetRepo: "https://github.com/owner/example-target-app",
  baseBranch: "main",
  repoConfigId: "target-app",
  resolutionSource: "explicit",
  previewProvider: "vercel",
};

describe("local prompt provider", () => {
  it("is the default and loads version-controlled templates", async () => {
    const provider = createLocalPromptProvider();
    const result = await provider.fetch("p-dev.planning", { provider: "local" });
    expect(result.ok).toBe(true);
    expect(result.template?.source).toBe("local");
    expect(result.template?.contractVersion).toBe("planning@1");
    expect(result.template?.langfusePromptJson).toBeNull();
    expect(result.template?.templateSha256).toHaveLength(64);
  });
});

describe("langfuse prompt provider", () => {
  it("falls back when provider disabled", async () => {
    const provider = createLangfusePromptProvider(async () => null);
    const result = await provider.fetch("p-dev.planning", {
      provider: "langfuse_with_local_fallback",
      label: "dogfood",
    });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe("provider_disabled");
  });

  it("rejects latest label", async () => {
    const provider = createLangfusePromptProvider(async () => null);
    const result = await provider.fetch("p-dev.planning", {
      provider: "langfuse_with_local_fallback",
      label: "latest",
    });
    expect(result.fallbackReason).toBe("latest_forbidden");
  });

  it("requires contractVersion on remote prompts", async () => {
    const client: LangfusePromptClientLike = {
      prompt: {
        get: async () => ({
          name: "p-dev.planning",
          version: 3,
          labels: ["dogfood"],
          type: "text",
          prompt: "Hello {{issueKey}}",
          config: {},
          isFallback: false,
          toJSON: () => JSON.stringify({ name: "p-dev.planning", version: 3 }),
        }),
      },
    };
    const provider = createLangfusePromptProvider(async () => client);
    const result = await provider.fetch("p-dev.planning", {
      provider: "langfuse_with_local_fallback",
      label: "dogfood",
    });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe("contract_mismatch");
  });

  it("accepts matching remote contract and caches", async () => {
    let calls = 0;
    const client: LangfusePromptClientLike = {
      prompt: {
        get: async () => {
          calls += 1;
          return {
            name: "p-dev.planning",
            version: 3,
            labels: ["dogfood"],
            type: "text" as const,
            prompt: "Remote {{issueKey}}",
            config: { contractVersion: "planning@1" },
            isFallback: false,
            toJSON: () => JSON.stringify({ name: "p-dev.planning", version: 3 }),
          };
        },
      },
    };
    const provider = createLangfusePromptProvider(async () => client);
    const a = await provider.fetch("p-dev.planning", {
      provider: "langfuse_with_local_fallback",
      label: "dogfood",
      cacheTtlSeconds: 60,
    });
    const b = await provider.fetch("p-dev.planning", {
      provider: "langfuse_with_local_fallback",
      label: "dogfood",
      cacheTtlSeconds: 60,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toBe(1);
    expect(a.template?.providerVersion).toBe(3);
  });

  it("falls back on remote outage during resolve", async () => {
    const resolved = await resolvePhasePrompt({
      phase: "planning",
      variables: { issueKey: "WES-1" },
      localCompiledPrompt: "LOCAL COMPILED",
      providerConfig: {
        provider: "langfuse_with_local_fallback",
        label: "dogfood",
      },
      preferredSkillMode: "rendered_fallback",
    });
    // Without env credentials factory returns null → fallback
    expect(resolved.fallbackUsed).toBe(true);
    expect(resolved.source).toBe("local");
    expect(resolved.langfusePromptJson).toBeNull();
    expect(resolved.skillInvocationMode).toBe("rendered_into_prompt");
    expect(resolved.skillResults[0]?.discovered).toBeNull();
    expect(resolved.skillResults[0]?.invoked).toBeNull();
    expect(resolved.renderedPrompt).toContain("LOCAL COMPILED");
    expect(resolved.renderedPrompt).toContain("Canonical skill: planner");
  });
});

describe("assembleAgentPrompt", () => {
  it("uses local provider and deterministic hashes", async () => {
    const { prompt: base } = await buildPlanningPrompt(issue, parsed, resolved);
    const assembled = await assembleAgentPrompt({
      phase: "planning",
      localCompiledPrompt: base,
    });
    expect(assembled.assembly.source).toBe("local");
    expect(assembled.assembly.skillInvocationMode).toBe("rendered_into_prompt");
    expect(assembled.assembly.langfusePromptLinked).toBe(false);
    expect(assembled.assembly.renderedPromptSha256).toBe(
      sha256Text(assembled.prompt),
    );
    expect(assembled.prompt).not.toContain(".cursor/skills");
  });
});
