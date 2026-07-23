import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
  launchSurfacesManifestDigest,
  sendSurfacesManifestDigest,
} from "../../src/provenance/launch-surfaces.js";
import { createPlanningCloudAgent } from "../../src/cursor/agent-factory.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";

const PHASE_DIR = path.resolve("src/runner/phases");
const PRODUCTION_PHASE_FILES = [
  "planning.ts",
  "plan-review.ts",
  "implementation.ts",
  "code-review.ts",
  "code-revision.ts",
  "revision.ts",
  "integration-repair.ts",
];

/** Independently enumerate launch call sites from production.ts exports. */
function enumerateProductionLaunchCallSites(): string[] {
  const production = readFileSync("src/agents/production.ts", "utf8");
  const sites: string[] = [];
  if (production.includes("createPlanningAgent")) sites.push("planning.create");
  if (production.includes("createPlanReviewAgent")) sites.push("plan_review.create");
  if (production.includes("resumePlanReviewAgent")) sites.push("plan_review.resume");
  if (production.includes("createCodeReviewAgent")) sites.push("code_review.create");
  if (production.includes("createCodeRevisionAgent")) sites.push("code_revision.create");
  if (production.includes("acquireBuilderAgent")) {
    sites.push(
      "implementation.initial_create",
      "implementation.resume",
      "implementation.replacement",
      "revision.resume",
      "revision.replacement",
      "integration_repair.resume",
      "integration_repair.replacement",
    );
  }
  return [...new Set(sites)].sort();
}

/** Independently enumerate send call sites from phase sources. */
function enumerateProductionSendCallSites(): string[] {
  const sites = new Set<string>();
  for (const file of PRODUCTION_PHASE_FILES) {
    const src = readFileSync(path.join(PHASE_DIR, file), "utf8");
    if (!src.includes("sendAndObserve(")) continue;
    if (file === "planning.ts") {
      sites.add("planning.send");
      if (src.includes("quality_repair") || src.includes("sendOrdinal: 2")) {
        sites.add("planning.send.quality_repair");
      }
    } else if (file === "plan-review.ts") sites.add("plan_review.send");
    else if (file === "implementation.ts") sites.add("implementation.send");
    else if (file === "revision.ts") sites.add("revision.send");
    else if (file === "code-review.ts") sites.add("code_review.send");
    else if (file === "code-revision.ts") sites.add("code_revision.send");
    else if (file === "integration-repair.ts") sites.add("integration_repair.send");
  }
  return [...sites].sort();
}

describe("production provenance boundary", () => {
  it("launch surfaces match independently enumerated production call sites", () => {
    const callSites = enumerateProductionLaunchCallSites();
    expect(callSites).toEqual([...PRODUCTION_LAUNCH_SURFACES].sort());
    expect(launchSurfacesManifestDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("send surfaces match independently enumerated production send call sites", () => {
    const callSites = enumerateProductionSendCallSites();
    expect(callSites).toEqual([...PRODUCTION_SEND_SURFACES].sort());
    expect(sendSurfacesManifestDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("production phase modules import agents/production not generic index create/acquire", () => {
    for (const file of PRODUCTION_PHASE_FILES) {
      const src = readFileSync(path.join(PHASE_DIR, file), "utf8");
      expect(src).toContain('from "../../agents/production.js"');
      expect(src).not.toMatch(/from ["']\.\.\/\.\.\/agents\/index\.js["']/);
      expect(src).not.toContain("agent-factory");
      expect(src).not.toContain("cursor-provider");
    }
  });

  it("production phases invoke sendAndObserve only via production wrapper import", () => {
    for (const file of PRODUCTION_PHASE_FILES) {
      const src = readFileSync(path.join(PHASE_DIR, file), "utf8");
      if (!src.includes("sendAndObserve")) continue;
      expect(src).toContain('from "../../agents/production.js"');
      expect(src).not.toMatch(
        /from ["']\.\.\/\.\.\/agents\/(index|cursor-provider)\.js["']/,
      );
    }
  });

  it("production wrapper send path includes run intent and call-start hooks", () => {
    const provider = readFileSync(
      "src/agents/linear-harness-provider.ts",
      "utf8",
    );
    expect(provider).toContain("writeProviderRunIntent");
    expect(provider).toContain("writeProviderRunCallStarted");
    expect(provider).toMatch(/writeProviderRunIntent[\s\S]*writeProviderRunCallStarted[\s\S]*inner\.sendAndObserve/);
  });

  it("generic agent factory create path does not import provenance writer", () => {
    const factory = readFileSync("src/cursor/agent-factory.ts", "utf8");
    expect(factory).not.toContain("provenance");
    expect(typeof createPlanningCloudAgent).toBe("function");
  });

  it("native-skill canary does not import provenance modules", () => {
    const canary = readFileSync(
      "src/evaluation/native-skill-canary/run.ts",
      "utf8",
    );
    expect(canary).not.toContain("src/provenance");
    expect(canary).not.toContain("linear-harness-provider");
  });

  it("sdk usage probe does not import provenance modules", () => {
    const probe = readFileSync(
      "src/evaluation/cursor-sdk-usage-probe/run.ts",
      "utf8",
    );
    expect(probe).not.toContain("src/provenance");
    expect(probe).not.toContain("linear-harness-provider");
  });

  it("in-memory store starts empty (no live state writes)", () => {
    const store = new InMemoryProvenanceEventStore();
    expect(store.listEvents()).toEqual([]);
  });

  it("phase directory still contains only known production launch files", () => {
    const files = readdirSync(PHASE_DIR).filter((f) => f.endsWith(".ts"));
    for (const required of PRODUCTION_PHASE_FILES) {
      expect(files).toContain(required);
    }
  });

  it("new production phase mutation files must be included in structural scan", () => {
    const mutationFiles = readdirSync(PHASE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => {
        const src = readFileSync(path.join(PHASE_DIR, f), "utf8");
        return (
          src.includes("createPlanningAgent") ||
          src.includes("createPlanReviewAgent") ||
          src.includes("createCodeReviewAgent") ||
          src.includes("createCodeRevisionAgent") ||
          src.includes("acquireBuilderAgent") ||
          src.includes("sendAndObserve")
        );
      })
      .sort();
    for (const file of mutationFiles) {
      expect(PRODUCTION_PHASE_FILES).toContain(file);
    }
  });
});
