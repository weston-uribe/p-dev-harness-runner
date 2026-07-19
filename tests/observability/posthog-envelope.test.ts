import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostHogAnalyticsTransport } from "../../src/observability/adapters/posthog.js";

describe("PostHog analytics transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends immediate capture requests with geoip disabled and no person profiles", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        requests.push({
          url,
          body: String(options?.body ?? ""),
        });
        return new Response("{}", { status: 200 });
      }),
    );

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

    await transport.flush(2_000);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/batch/");
    const payload = JSON.parse(requests[0]!.body);
    expect(payload.api_key).toBe("phc_test_token");
    expect(payload.batch[0].event).toBe("p_dev_session_started");
    expect(payload.batch[0].properties.$process_person_profile).toBe(false);
    expect(payload.batch[0].distinct_id).toBe("install_123");
  });

  it("bounds pending plus in-flight captures and drops excess events deterministically", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetchBlocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const requests: Array<{ body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options?: RequestInit) => {
        requests.push({ body: String(options?.body ?? "") });
        await fetchBlocked;
        return new Response("{}", { status: 200 });
      }),
    );

    const transport = createPostHogAnalyticsTransport({
      projectToken: "phc_test_token",
      host: "http://127.0.0.1:9",
      maxOperations: 2,
    });

    for (let index = 0; index < 5; index += 1) {
      transport.capture({
        event: "p_dev_configure_step_viewed",
        properties: {
          distinct_id: "install_123",
          $process_person_profile: false,
          session_id: "session_123",
          step_id: `step_${index}`,
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    releaseFetch?.();
    await transport.flush(2_000);
    const bodies = requests.map((request) => request.body).join("\n");
    expect(bodies).toContain("step_0");
    expect(bodies).toContain("step_1");
    expect(bodies).not.toContain("step_2");
    expect(bodies).not.toContain("step_3");
    expect(bodies).not.toContain("step_4");
  });

  it("discards queued uninitiated captures when consent is withdrawn before drain", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        return new Response("{}", { status: 200 });
      }),
    );

    const transport = createPostHogAnalyticsTransport({
      projectToken: "phc_test_token",
      host: "http://127.0.0.1:9",
      maxOperations: 2,
    });

    transport.capture({
      event: "p_dev_configure_step_viewed",
      properties: {
        distinct_id: "install_123",
        $process_person_profile: false,
      },
    });
    await transport.disableAndDrop(2_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCount).toBe(0);
    expect(transport.isActive()).toBe(false);
  });

  it("does not initiate new capture work after disableAndDrop closes the gate", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstFetchStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let fetchCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          releaseFirst?.();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return new Response("{}", { status: 200 });
      }),
    );

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
    await firstFetchStarted;
    await transport.disableAndDrop(2_000);
    transport.capture({
      event: "p_dev_configure_step_completed",
      properties: {
        distinct_id: "install_123",
        $process_person_profile: false,
      },
    });
    await transport.flush(2_000);

    expect(fetchCount).toBe(1);
    expect(transport.isActive()).toBe(false);
  });
});
