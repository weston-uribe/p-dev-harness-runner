import { afterEach, describe, expect, it, vi } from "vitest";

const { mockShutdown, mockPrivateShutdown, PostHogMock } = vi.hoisted(() => {
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  const mockPrivateShutdown = vi.fn().mockResolvedValue(undefined);
  const PostHogMock = vi.fn(() => ({
    captureImmediate: vi.fn().mockResolvedValue(undefined),
    shutdown: mockShutdown,
    _shutdown: mockPrivateShutdown,
  }));
  return { mockShutdown, mockPrivateShutdown, PostHogMock };
});

vi.mock("posthog-node", () => ({
  PostHog: PostHogMock,
}));

import { createPostHogAnalyticsTransport } from "../../src/observability/adapters/posthog.js";

describe("PostHog adapter shutdown lifecycle", () => {
  afterEach(() => {
    mockShutdown.mockClear();
    mockPrivateShutdown.mockClear();
    PostHogMock.mockClear();
  });

  it("ordinary shutdown invokes the supported public lifecycle path", async () => {
    const transport = createPostHogAnalyticsTransport({
      projectToken: "phc_test_token",
      host: "http://127.0.0.1:9",
    });

    transport.capture({
      event: "p_dev_session_started",
      properties: {
        distinct_id: "install_123",
        $process_person_profile: false,
        session_id: "session_123",
      },
    });

    await transport.shutdown({ deadlineMs: 1_500 });

    expect(mockShutdown).toHaveBeenCalledWith(1_500);
    expect(mockPrivateShutdown).not.toHaveBeenCalled();
  });

  it("consent withdrawal does not call public shutdown", async () => {
    const transport = createPostHogAnalyticsTransport({
      projectToken: "phc_test_token",
      host: "http://127.0.0.1:9",
    });

    transport.capture({
      event: "p_dev_configure_step_viewed",
      properties: {
        distinct_id: "install_123",
        $process_person_profile: false,
      },
    });

    await transport.disableAndDrop(2_000);

    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockPrivateShutdown).not.toHaveBeenCalled();
    expect(transport.isActive()).toBe(false);
  });
});
