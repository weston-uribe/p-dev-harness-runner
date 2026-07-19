import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalReadinessVisualQueue } from "../../apps/gui/lib/local-readiness-visual-queue";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("local readiness visual queue", () => {
  it("drains started and completed events sequentially", async () => {
    const dispatched: string[] = [];
    const queue = new LocalReadinessVisualQueue((event) => {
      dispatched.push(
        event.type === "check-started"
          ? `start:${event.id}`
          : `done:${event.check.id}`,
      );
    }, true);

    queue.enqueue({ type: "check-started", id: "a", label: "A" });
    queue.enqueue({
      type: "check-completed",
      check: { id: "a", label: "A", status: "passed" },
    });
    queue.enqueue({ type: "check-started", id: "b", label: "B" });
    queue.enqueue({
      type: "check-completed",
      check: { id: "b", label: "B", status: "passed" },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(dispatched).toEqual(["start:a", "done:a", "start:b", "done:b"]);
  });

  it("guided Step 5 uses the NDJSON stream route", () => {
    const source = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );

    expect(source).toContain('/api/setup/local-readiness?stream=1');
    expect(source).toContain("LocalReadinessVisualQueue");
    expect(source).toContain("AbortController");
    expect(source).toContain("runGenerationRef");
  });

  it("local readiness route supports NDJSON streaming", () => {
    const source = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/app/api/setup/local-readiness/route.ts",
      ),
      "utf8",
    );

    expect(source).toContain("runLocalReadinessChecksProgress");
    expect(source).toContain("application/x-ndjson");
    expect(source).toContain('searchParams.get("stream")');
  });
});
