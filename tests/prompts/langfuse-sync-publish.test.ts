import { describe, expect, it } from "vitest";
import { prepareLangfusePromptSync } from "../../src/prompts/langfuse-sync.js";

describe("langfuse prompt sync publish", () => {
  it("dry-run never publishes", async () => {
    const plan = await prepareLangfusePromptSync({ dryRun: true, label: "dogfood" });
    expect(plan.dryRun).toBe(true);
    expect(plan.published).toBe(false);
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.entries.every((e) => e.publishedVersion == null)).toBe(true);
  });

  it("refuses latest label", async () => {
    await expect(
      prepareLangfusePromptSync({ label: "latest", publish: true }),
    ).rejects.toThrow(/latest/);
  });

  it("publishes immutable versions with approved label via publisher", async () => {
    const versions = new Map<string, number>();
    const plan = await prepareLangfusePromptSync({
      publish: true,
      label: "dogfood",
      publisher: {
        create: async (body) => {
          expect(body.labels).toEqual(["dogfood"]);
          expect(body.config.contractVersion).toBeTruthy();
          expect(body.type).toBe("text");
          const next = (versions.get(body.name) ?? 0) + 1;
          versions.set(body.name, next);
          return { version: next };
        },
      },
    });
    expect(plan.published).toBe(true);
    expect(plan.entries.every((e) => e.publishedVersion === 1)).toBe(true);
    expect(plan.entries.some((e) => e.name === "p-dev.plan-review")).toBe(true);
    expect(plan.entries.some((e) => e.name === "p-dev.code-review")).toBe(true);
  });
});
