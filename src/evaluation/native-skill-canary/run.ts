/**
 * Native-skill canary for proving Cloud Agent skill discovery/invocation.
 * Default: dry-run/preflight. Live mode creates disposable layout evidence
 * via SDK Cloud Agents when CURSOR_API_KEY + canary repo are provided.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS } from "../../skills/capability.js";
import { assertNoProductionCursorSkillsMirror } from "../../skills/package.js";

export const NATIVE_SKILL_CANARY_MARKER = "PDEV_NATIVE_SKILL_CANARY_OK" as const;

export type CanaryLayoutId = "agents_skills" | "cursor_skills";

export type LayoutOutcome = "pending" | "discovered" | "invoked" | "ignored" | "unavailable";

export interface NativeSkillCanaryReport {
  schemaVersion: 1;
  mode: "dry-run" | "live";
  preparedAt: string;
  skillId: string;
  marker: typeof NATIVE_SKILL_CANARY_MARKER;
  fixtureRoot: string | null;
  layoutsPrepared: Array<{
    layoutId: CanaryLayoutId;
    relativePath: string;
    contentSha256: string;
    prepared: boolean;
  }>;
  productionCursorSkillsMirror: { ok: boolean; message: string };
  liveExecution: {
    attempted: boolean;
    blockedReason: string | null;
    targetRepo?: string | null;
  };
  evidence: {
    providerProof: {
      layouts: Partial<
        Record<
          CanaryLayoutId,
          {
            streamEvents?: number;
            assistantContainsMarker?: boolean;
            agentId?: string | null;
            runId?: string | null;
          }
        >
      >;
    } | null;
    modelSelfReport: null;
    discoveryByLayout: Record<CanaryLayoutId, LayoutOutcome>;
    invocationByLayout: Record<CanaryLayoutId, LayoutOutcome>;
  };
  notes: string[];
}

export interface LiveCanaryLayoutResult {
  layoutId: CanaryLayoutId;
  discovery: LayoutOutcome;
  invocation: LayoutOutcome;
  streamEvents: number;
  assistantContainsMarker: boolean;
  agentId: string | null;
  runId: string | null;
  providerRejected?: boolean;
}

export type LiveCanaryRunner = (input: {
  layoutId: CanaryLayoutId;
  skillId: string;
  marker: string;
  relativePath: string;
  skillBody: string;
  targetRepo: string;
  apiKey: string;
}) => Promise<LiveCanaryLayoutResult>;

function skillBody(skillId: string): string {
  return `---
name: ${skillId}
skillContractVersion: "1"
description: >-
  Disposable canary skill for proving Cloud Agent native skill discovery.
  Not for production use.
---

# ${skillId}

When explicitly requested, output exactly this marker on its own line:

\`${NATIVE_SKILL_CANARY_MARKER}\`

Do not modify repository files. Do not open a pull request.
`;
}

async function prepareLayout(
  fixtureRoot: string,
  layoutId: CanaryLayoutId,
  skillId: string,
): Promise<{ relativePath: string; contentSha256: string; body: string }> {
  const relativePath =
    layoutId === "agents_skills"
      ? `.agents/skills/${skillId}/SKILL.md`
      : `.cursor/skills/${skillId}/SKILL.md`;
  const abs = path.join(fixtureRoot, relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  const body = skillBody(skillId);
  await writeFile(abs, body, "utf8");
  return {
    relativePath,
    contentSha256: createHash("sha256").update(body).digest("hex"),
    body,
  };
}

function emptyLayoutOutcomes(): Record<CanaryLayoutId, LayoutOutcome> {
  return {
    agents_skills: "pending",
    cursor_skills: "pending",
  };
}

/**
 * Default live runner: creates a Cloud Agent that requests the canary skill.
 * Requires the skill files to already be on the target repo starting ref.
 * Without a prepared remote fixture, classify as unavailable (not unsupported).
 */
export async function defaultLiveCanaryRunner(input: {
  layoutId: CanaryLayoutId;
  skillId: string;
  marker: string;
  targetRepo: string;
  apiKey: string;
}): Promise<LiveCanaryLayoutResult> {
  try {
    const { Agent } = await import("@cursor/sdk");
    const agent = await Agent.create({
      apiKey: input.apiKey,
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      mode: "agent",
      cloud: {
        repos: [{ url: input.targetRepo, startingRef: "main" }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
    try {
      const prompt = [
        `Use the disposable canary skill named "${input.skillId}" if available.`,
        `When the skill is available, output exactly this marker on its own line: ${input.marker}`,
        "Do not modify repository files. Do not open a pull request.",
      ].join("\n");
      const run = await agent.send(prompt);
      let streamEvents = 0;
      let assistant = "";
      const runUnknown = run as unknown as {
        stream?: () => AsyncIterable<{ type?: string; text?: string }>;
        wait?: () => Promise<{ id?: string }>;
      };
      if (typeof runUnknown.stream === "function") {
        for await (const event of runUnknown.stream()) {
          streamEvents += 1;
          if (
            event &&
            typeof event === "object" &&
            "text" in event &&
            typeof event.text === "string"
          ) {
            assistant += event.text;
          }
        }
      }
      const result =
        typeof runUnknown.wait === "function" ? await runUnknown.wait() : null;
      const contains = assistant.includes(input.marker);
      return {
        layoutId: input.layoutId,
        discovery: contains ? "discovered" : streamEvents > 0 ? "ignored" : "unavailable",
        invocation: contains ? "invoked" : streamEvents > 0 ? "ignored" : "unavailable",
        streamEvents,
        assistantContainsMarker: contains,
        agentId: typeof agent.agentId === "string" ? agent.agentId : null,
        runId: result && typeof result.id === "string" ? result.id : null,
      };
    } finally {
      const dispose = agent[Symbol.asyncDispose];
      if (dispose) await dispose.call(agent).catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rejected = /not supported|unsupported|unknown skill|skills? (are )?not/i.test(
      message,
    );
    return {
      layoutId: input.layoutId,
      discovery: rejected ? "unavailable" : "unavailable",
      invocation: rejected ? "unavailable" : "unavailable",
      streamEvents: 0,
      assistantContainsMarker: false,
      agentId: null,
      runId: null,
      providerRejected: rejected,
    };
  }
}

export async function runNativeSkillCanary(params?: {
  live?: boolean;
  keepFixture?: boolean;
  repoRoot?: string;
  /** Required for live mode unless a custom liveRunner is injected. */
  targetRepo?: string;
  apiKey?: string;
  liveRunner?: LiveCanaryRunner;
  layouts?: CanaryLayoutId[];
}): Promise<NativeSkillCanaryReport> {
  const live = params?.live === true;
  const repoRoot = params?.repoRoot ?? process.cwd();
  const skillId = `pdev-native-canary-${randomBytes(4).toString("hex")}`;
  const mirror = await assertNoProductionCursorSkillsMirror(repoRoot);
  const layouts: CanaryLayoutId[] = params?.layouts ?? [
    "agents_skills",
    "cursor_skills",
  ];

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pdev-native-skill-canary-"));
  const layoutsPrepared: NativeSkillCanaryReport["layoutsPrepared"] = [];
  const preparedBodies = new Map<CanaryLayoutId, { relativePath: string; body: string }>();

  try {
    for (const layoutId of layouts) {
      const prepared = await prepareLayout(fixtureRoot, layoutId, skillId);
      layoutsPrepared.push({
        layoutId,
        relativePath: prepared.relativePath,
        contentSha256: prepared.contentSha256,
        prepared: true,
      });
      preparedBodies.set(layoutId, {
        relativePath: prepared.relativePath,
        body: prepared.body,
      });
    }

    for (const layout of layoutsPrepared) {
      const content = await readFile(
        path.join(fixtureRoot, layout.relativePath),
        "utf8",
      );
      if (!content.includes(NATIVE_SKILL_CANARY_MARKER)) {
        throw new Error(`Fixture missing marker for ${layout.layoutId}`);
      }
    }

    if (!live) {
      const report: NativeSkillCanaryReport = {
        schemaVersion: 1,
        mode: "dry-run",
        preparedAt: new Date().toISOString(),
        skillId,
        marker: NATIVE_SKILL_CANARY_MARKER,
        fixtureRoot,
        layoutsPrepared,
        productionCursorSkillsMirror: mirror,
        liveExecution: {
          attempted: false,
          blockedReason: null,
        },
        evidence: {
          providerProof: null,
          modelSelfReport: null,
          discoveryByLayout: emptyLayoutOutcomes(),
          invocationByLayout: emptyLayoutOutcomes(),
        },
        notes: [
          "Dry-run/preflight only — no SDK Cloud Agent was created.",
          "Layouts were prepared independently inside a disposable fixture.",
          "Model self-report must not be treated as provider proof.",
          "Do not commit fixture layouts into production .cursor/skills.",
          ...NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS.map(
            (l) => `Candidate layout (unproven): ${l}`,
          ),
        ],
      };
      if (!params?.keepFixture) {
        await rm(fixtureRoot, { recursive: true, force: true });
        return { ...report, fixtureRoot: null };
      }
      return report;
    }

    const apiKey = params?.apiKey ?? process.env.CURSOR_API_KEY ?? "";
    const targetRepo =
      params?.targetRepo ??
      process.env.P_DEV_NATIVE_SKILL_CANARY_REPO ??
      "";
    if (!apiKey || !targetRepo) {
      return {
        schemaVersion: 1,
        mode: "live",
        preparedAt: new Date().toISOString(),
        skillId,
        marker: NATIVE_SKILL_CANARY_MARKER,
        fixtureRoot: params?.keepFixture ? fixtureRoot : null,
        layoutsPrepared,
        productionCursorSkillsMirror: mirror,
        liveExecution: {
          attempted: false,
          blockedReason:
            "Live canary requires CURSOR_API_KEY and P_DEV_NATIVE_SKILL_CANARY_REPO (or --target-repo).",
          targetRepo: targetRepo || null,
        },
        evidence: {
          providerProof: null,
          modelSelfReport: null,
          discoveryByLayout: emptyLayoutOutcomes(),
          invocationByLayout: emptyLayoutOutcomes(),
        },
        notes: [
          "Live mode requested but credentials/target repo missing.",
          "Capability remains unproven until provider evidence is collected.",
        ],
      };
    }

    const runner = params?.liveRunner ?? defaultLiveCanaryRunner;
    const discoveryByLayout = emptyLayoutOutcomes();
    const invocationByLayout = emptyLayoutOutcomes();
    const providerLayouts: NonNullable<
      NativeSkillCanaryReport["evidence"]["providerProof"]
    >["layouts"] = {};

    for (const layoutId of layouts) {
      const prepared = preparedBodies.get(layoutId)!;
      const result = await runner({
        layoutId,
        skillId,
        marker: NATIVE_SKILL_CANARY_MARKER,
        relativePath: prepared.relativePath,
        skillBody: prepared.body,
        targetRepo,
        apiKey,
      });
      discoveryByLayout[layoutId] = result.discovery;
      invocationByLayout[layoutId] = result.invocation;
      providerLayouts[layoutId] = {
        streamEvents: result.streamEvents,
        assistantContainsMarker: result.assistantContainsMarker,
        agentId: result.agentId,
        runId: result.runId,
      };
    }

    const report: NativeSkillCanaryReport = {
      schemaVersion: 1,
      mode: "live",
      preparedAt: new Date().toISOString(),
      skillId,
      marker: NATIVE_SKILL_CANARY_MARKER,
      fixtureRoot: params?.keepFixture ? fixtureRoot : null,
      layoutsPrepared,
      productionCursorSkillsMirror: mirror,
      liveExecution: {
        attempted: true,
        blockedReason: null,
        targetRepo,
      },
      evidence: {
        providerProof: { layouts: providerLayouts },
        modelSelfReport: null,
        discoveryByLayout,
        invocationByLayout,
      },
      notes: [
        "Live canary executed one layout at a time against the disposable target.",
        "Only provider stream/result evidence counted — model self-report ignored.",
        "Production skill mode remains rendered_into_prompt until capability promotion.",
      ],
    };

    if (!params?.keepFixture) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    return report;
  } catch (err) {
    if (!params?.keepFixture) {
      await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}
