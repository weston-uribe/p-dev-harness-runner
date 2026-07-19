import { describe, expect, it } from "vitest";
import {
  NATIVE_SKILL_CANARY_MARKER,
  runNativeSkillCanary,
} from "../../src/evaluation/native-skill-canary/run.js";
import { existsSync } from "node:fs";
import path from "node:path";

describe("native skill canary preflight", () => {
  it("prepares isolated layouts and cleans up by default", async () => {
    const report = await runNativeSkillCanary();
    expect(report.mode).toBe("dry-run");
    expect(report.marker).toBe(NATIVE_SKILL_CANARY_MARKER);
    expect(report.layoutsPrepared).toHaveLength(2);
    expect(report.layoutsPrepared.map((l) => l.layoutId).sort()).toEqual([
      "agents_skills",
      "cursor_skills",
    ]);
    expect(report.fixtureRoot).toBeNull();
    expect(report.liveExecution.attempted).toBe(false);
    expect(report.productionCursorSkillsMirror.ok).toBe(true);
    expect(report.evidence.providerProof).toBeNull();
    expect(report.evidence.modelSelfReport).toBeNull();
    expect(existsSync(path.join(process.cwd(), ".cursor", "skills"))).toBe(false);
  });

  it("blocks live without credentials", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevRepo = process.env.P_DEV_NATIVE_SKILL_CANARY_REPO;
    delete process.env.CURSOR_API_KEY;
    delete process.env.P_DEV_NATIVE_SKILL_CANARY_REPO;
    try {
      const report = await runNativeSkillCanary({ live: true });
      expect(report.mode).toBe("live");
      expect(report.liveExecution.attempted).toBe(false);
      expect(report.liveExecution.blockedReason).toMatch(/CURSOR_API_KEY/);
      expect(report.layoutsPrepared.length).toBeGreaterThan(0);
    } finally {
      if (prevKey !== undefined) process.env.CURSOR_API_KEY = prevKey;
      if (prevRepo !== undefined) process.env.P_DEV_NATIVE_SKILL_CANARY_REPO = prevRepo;
    }
  });

  it("live mode records provider evidence via injectable runner", async () => {
    const report = await runNativeSkillCanary({
      live: true,
      apiKey: "test-key",
      targetRepo: "https://github.com/example/canary-fixture",
      layouts: ["agents_skills"],
      liveRunner: async ({ layoutId }) => ({
        layoutId,
        discovery: "discovered",
        invocation: "invoked",
        streamEvents: 3,
        assistantContainsMarker: true,
        agentId: "agent-1",
        runId: "run-1",
      }),
    });
    expect(report.mode).toBe("live");
    expect(report.liveExecution.attempted).toBe(true);
    expect(report.evidence.discoveryByLayout.agents_skills).toBe("discovered");
    expect(report.evidence.invocationByLayout.agents_skills).toBe("invoked");
    expect(report.evidence.providerProof?.layouts.agents_skills?.assistantContainsMarker).toBe(
      true,
    );
    expect(report.evidence.modelSelfReport).toBeNull();
  });
});
