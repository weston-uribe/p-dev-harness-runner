import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOrAdoptRecoveryRoot,
  parseRecoveryOperationRootRecord,
  recoveryRootSubjectKey,
} from "../../src/provenance/recovery-operation.js";
import { InMemoryProvenanceLifecycleStore } from "../../src/provenance/lifecycle-store.js";
import { recoveryOperationRootRemotePath } from "../../src/provenance/paths.js";

describe("recovery operation root CAS", () => {
  it("converges across different creator session IDs", async () => {
    const store = new InMemoryProvenanceLifecycleStore();
    const recoveryOperationId = randomUUID();
    const base = {
      priorEpochId: "live-rollout-2026-07-24-required",
      recoveryOperationId,
      newEpochId: "live-rollout-2026-07-25-repair",
      plannedStage: "required_canary",
      activationScheduleIdentity: "schedule-v1",
    };

    const first = await createOrAdoptRecoveryRoot(store, {
      ...base,
      creatorSessionId: "session-alpha",
    });
    expect(first.adopted).toBe(false);

    const second = await createOrAdoptRecoveryRoot(store, {
      ...base,
      creatorSessionId: "session-beta",
    });
    expect(second.adopted).toBe(true);
    expect(second.record.recoveryOperationId).toBe(recoveryOperationId);
    expect(second.record.newEpochId).toBe(base.newEpochId);

    const path = recoveryOperationRootRemotePath(
      base.priorEpochId,
      "1",
    );
    const body = await store.loadRecord(path);
    expect(body).toBeTruthy();
    const parsed = parseRecoveryOperationRootRecord(body!);
    expect(parsed.creatorSessionId).toBe("session-alpha");
    expect(recoveryRootSubjectKey(base.priorEpochId, "1")).toBe(
      `${base.priorEpochId}/1`,
    );
  });
});
