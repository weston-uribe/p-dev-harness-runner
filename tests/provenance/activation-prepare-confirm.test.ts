import { describe, expect, it, vi, expectTypeOf } from "vitest";
import { CoverageLifecycleService } from "../../src/provenance/coverage-lifecycle.js";
import {
  InMemoryProvenanceLifecycleStore,
} from "../../src/provenance/lifecycle-store.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";
import {
  activateEpoch,
  confirmActivationReadinessRequired,
} from "../../src/provenance/operator-coverage.js";
import { activationReadinessRemotePath } from "../../src/provenance/paths.js";
import { parseActivationReadinessRecord } from "../../src/provenance/coverage-lifecycle-schemas.js";
import { runProvenanceRolloutCommand } from "../../src/cli/commands/provenance-rollout.js";

function makeCtx(input: {
  getCommitTimestamp: (sha: string) => string;
}) {
  const lifecycleStore = new InMemoryProvenanceLifecycleStore();
  const eventStore = new InMemoryProvenanceEventStore();
  const client = {
    getCommit: async (_owner: string, _repo: string, sha: string) => ({
      sha,
      commit: { committer: { date: input.getCommitTimestamp(sha) } },
    }),
  } as any;
  const service = new CoverageLifecycleService({
    lifecycleStore,
    eventStore,
    client,
    owner: "o",
    repo: "r",
    branch: "b",
    stateRepository: "o/r",
  });
  const ctx = {
    service,
    lifecycleStore,
    eventStore,
    client,
    stateRepository: "o/r",
    stateBranch: "b",
    owner: "o",
    repo: "r",
  } as any;
  return { ctx, lifecycleStore };
}

describe("WS7 activation prepare/confirm", () => {
  it("CLI options do not accept activationCommitTimestamp", () => {
    type Opts = Parameters<typeof runProvenanceRolloutCommand>[0];
    expectTypeOf<Opts>().not.toMatchTypeOf<{ activationCommitTimestamp: string }>();
  });

  it("fails when activation commit timestamp is after activatedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const { ctx } = makeCtx({
      getCommitTimestamp: () => "2026-08-01T12:00:01.000Z",
    });

    await expect(
      activateEpoch(ctx, {
        epochId: "epoch-prepare-1",
        activatedAt,
        coverageStart: activatedAt,
        coverageEnd: "2026-08-01T13:00:00.000Z",
        captureProducerSourceSha: "a".repeat(40),
        productionRunnerSha: "runner-1",
        requireFutureEffective: true,
        minGuardDurationMs: 0,
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_coverage_incomplete" });
  });

  it("fails when remaining guard window is insufficient", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T11:59:50.000Z"));
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const { ctx } = makeCtx({
      getCommitTimestamp: () => "2026-08-01T11:59:50.000Z",
    });

    await expect(
      activateEpoch(ctx, {
        epochId: "epoch-prepare-2",
        activatedAt,
        coverageStart: activatedAt,
        coverageEnd: "2026-08-01T13:00:00.000Z",
        captureProducerSourceSha: "a".repeat(40),
        productionRunnerSha: "runner-1",
        requireFutureEffective: true,
        minGuardDurationMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_coverage_incomplete" });
  });

  it("confirmation fails when mode is not required", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const { ctx } = makeCtx({
      getCommitTimestamp: () => "2026-08-01T11:00:00.000Z",
    });

    await activateEpoch(ctx, {
      epochId: "epoch-confirm-1",
      activatedAt,
      coverageStart: activatedAt,
      coverageEnd: "2026-08-01T13:00:00.000Z",
      captureProducerSourceSha: "a".repeat(40),
      productionRunnerSha: "runner-1",
      requireFutureEffective: true,
      minGuardDurationMs: 0,
    });

    await expect(
      confirmActivationReadinessRequired(ctx, {
        epochId: "epoch-confirm-1",
        minGuardDurationMs: 0,
        env: { P_DEV_CURSOR_PROVENANCE_MODE: "shadow" },
        quietWindow: {
          waitAndInspectQuietWindow: (async () => ({
            quiet: true,
            observedAt: "2026-08-01T11:01:00.000Z",
            activeRuns: [],
            tipSha: null,
            failClosedReason: null,
            priorObservation: { observedAt: "2026-08-01T11:00:30.000Z", activeRunIds: [] },
          })) as any,
        },
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_config_invalid" });
  });

  it("confirmation fails after cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const { ctx } = makeCtx({
      getCommitTimestamp: () => "2026-08-01T11:00:00.000Z",
    });

    await activateEpoch(ctx, {
      epochId: "epoch-confirm-2",
      activatedAt,
      coverageStart: activatedAt,
      coverageEnd: "2026-08-01T13:00:00.000Z",
      captureProducerSourceSha: "a".repeat(40),
      productionRunnerSha: "runner-1",
      requireFutureEffective: true,
      minGuardDurationMs: 60_000,
    });

    await expect(
      confirmActivationReadinessRequired(ctx, {
        epochId: "epoch-confirm-2",
        minGuardDurationMs: 60_000,
        env: { P_DEV_CURSOR_PROVENANCE_MODE: "required" },
        now: () => "2026-08-01T11:59:30.000Z",
        quietWindow: {
          waitAndInspectQuietWindow: (async () => ({
            quiet: true,
            observedAt: "2026-08-01T11:58:00.000Z",
            activeRuns: [],
            tipSha: null,
            failClosedReason: null,
            priorObservation: { observedAt: "2026-08-01T11:57:00.000Z", activeRunIds: [] },
          })) as any,
        },
      }),
    ).rejects.toMatchObject({ code: "cursor_provenance_coverage_incomplete" });
  });

  it("confirmation before activation succeeds and writes readiness record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
    const activatedAt = "2026-08-01T12:00:00.000Z";
    const { ctx, lifecycleStore } = makeCtx({
      getCommitTimestamp: () => "2026-08-01T11:00:00.000Z",
    });

    await activateEpoch(ctx, {
      epochId: "epoch-confirm-3",
      activatedAt,
      coverageStart: activatedAt,
      coverageEnd: "2026-08-01T13:00:00.000Z",
      captureProducerSourceSha: "a".repeat(40),
      productionRunnerSha: "runner-1",
      requireFutureEffective: true,
      minGuardDurationMs: 0,
    });

    const result = await confirmActivationReadinessRequired(ctx, {
      epochId: "epoch-confirm-3",
      minGuardDurationMs: 0,
      env: { P_DEV_CURSOR_PROVENANCE_MODE: "required" },
      now: () => "2026-08-01T11:01:00.000Z",
      quietWindow: {
        waitAndInspectQuietWindow: (async () => ({
          quiet: true,
          observedAt: "2026-08-01T11:01:30.000Z",
          activeRuns: [],
          tipSha: null,
          failClosedReason: null,
          priorObservation: { observedAt: "2026-08-01T11:01:00.000Z", activeRunIds: [] },
        })) as any,
      },
    });

    const body = await lifecycleStore.loadRecord(
      activationReadinessRemotePath("epoch-confirm-3"),
    );
    expect(body).toBeTruthy();
    const parsed = parseActivationReadinessRecord(body!);
    expect(parsed.activationCommitSha).toBe(result.activationCommitSha);
    expect(parsed.verifiedMode).toBe("required");
  });
});

