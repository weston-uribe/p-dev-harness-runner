import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../../src/cli/exit-codes.js";

const mocks = vi.hoisted(() => ({
  failJobRequest: vi.fn(),
  createGithubJobRequestStoreFromEnv: vi.fn(),
}));

vi.mock("../../src/workflow/job-request/claim.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/workflow/job-request/claim.js")>();
  return {
    ...actual,
    failJobRequest: mocks.failJobRequest,
  };
});

vi.mock("../../src/workflow/job-request/runtime-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/workflow/job-request/runtime-store.js")
    >();
  return {
    ...actual,
    createGithubJobRequestStoreFromEnv: mocks.createGithubJobRequestStoreFromEnv,
  };
});

import { runFailJobRequestCommand } from "../../src/cli/commands/fail-job-request.js";
import { JobRequestError } from "../../src/workflow/job-request/claim.js";

describe("runFailJobRequestCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGithubJobRequestStoreFromEnv.mockResolvedValue({ store: true });
    mocks.failJobRequest.mockResolvedValue({
      requestId: "dlv-test",
      state: "failed",
      completionState: "superseded_pre_building_failure",
      revision: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires request-id and completion-state", async () => {
    expect(
      await runFailJobRequestCommand({
        requestId: "",
        completionState: "superseded_pre_building_failure",
      }),
    ).toBe(EXIT_CONFIG);
    expect(
      await runFailJobRequestCommand({
        requestId: "dlv-test",
        completionState: "",
      }),
    ).toBe(EXIT_CONFIG);
    expect(mocks.failJobRequest).not.toHaveBeenCalled();
  });

  it("fails a job request with the provided completion state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runFailJobRequestCommand({
      requestId: "dlv-eb090c3c89c73bc68635aba4f7442ba9",
      completionState: "superseded_pre_building_failure",
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(mocks.createGithubJobRequestStoreFromEnv).toHaveBeenCalledTimes(1);
    expect(mocks.failJobRequest).toHaveBeenCalledWith(
      { store: true },
      {
        requestId: "dlv-eb090c3c89c73bc68635aba4f7442ba9",
        completionState: "superseded_pre_building_failure",
      },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Failed job request"),
    );
  });

  it("returns run failure when the store rejects the transition", async () => {
    mocks.failJobRequest.mockRejectedValue(
      new JobRequestError("missing", "request missing"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runFailJobRequestCommand({
      requestId: "dlv-missing",
      completionState: "superseded_pre_building_failure",
    });

    expect(exitCode).toBe(EXIT_RUN_FAILURE);
    expect(error).toHaveBeenCalledWith("request missing");
  });
});
