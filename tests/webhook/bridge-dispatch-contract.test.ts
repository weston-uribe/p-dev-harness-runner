import { describe, expect, it } from "vitest";
import {
  BRIDGE_HARNESS_OWNED_STATUS_EXAMPLES,
  BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES,
  isHarnessOwnedBridgeComment,
  isHumanOwnedDispatchStatus,
} from "../../src/webhook/bridge-dispatch-contract.js";
import { CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES } from "../../src/workflow/canonical-product-development-workflow.js";
import { buildVercelBridgeArtifactFiles } from "../../src/setup/vercel-bridge-artifact.js";

describe("bridge dispatch contract parity", () => {
  it("keeps typed allowlist and embedded artifact statuses aligned", () => {
    expect([...BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES]).toEqual([
      ...CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
    ]);
    const artifact = buildVercelBridgeArtifactFiles().find((f) =>
      f.file.endsWith(".js"),
    );
    expect(artifact).toBeDefined();
    for (const status of BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES) {
      expect(artifact!.data).toContain(status);
      expect(isHumanOwnedDispatchStatus(status)).toBe(true);
    }
    for (const status of BRIDGE_HARNESS_OWNED_STATUS_EXAMPLES) {
      expect(isHumanOwnedDispatchStatus(status)).toBe(false);
    }
    expect(artifact!.data).toContain("isHarnessOwnedComment");
    expect(artifact!.data).toContain("isHumanOwnedDispatchStatus");
    expect(artifact!.data).toContain("duplicate: true");
  });

  it("classifies harness-owned comments for bridge suppression", () => {
    expect(
      isHarnessOwnedBridgeComment(
        "<!-- p-dev-run-status:abc -->\n**PDev accepted this issue**",
      ),
    ).toBe(true);
    expect(
      isHarnessOwnedBridgeComment(
        "<!--\nharness-orchestrator-v1\nphase: build_complete\nrun_id: r1\n-->",
      ),
    ).toBe(true);
    expect(
      isHarnessOwnedBridgeComment(
        "**Phase:** PM handoff\n\n<!--\nharness-orchestrator-v1\nphase: handoff\nrun_id: r1\n-->",
      ),
    ).toBe(true);
    expect(isHarnessOwnedBridgeComment("Please revise the spacing.")).toBe(
      false,
    );
  });
});
