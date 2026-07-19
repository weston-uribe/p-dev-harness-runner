const timingEnabled =
  process.env.NODE_ENV !== "production" ||
  process.env.P_DEV_CONFIGURE_TIMING === "1";

type ConfigureTimingMark =
  | "configure_page_start"
  | "configure_loader_setup_summary"
  | "configure_loader_form_defaults"
  | "configure_loader_remote_summary"
  | "configure_loader_linear_summary"
  | "configure_loader_vercel_summary"
  | "configure_loader_harness_provisioning"
  | "configure_loader_observability"
  | "configure_page_ready"
  | "configure_nav_start"
  | "configure_shell_paint"
  | "configure_content_ready";

const serverStartMs = new Map<string, number>();

export function markConfigureServerStart(label: ConfigureTimingMark): void {
  if (!timingEnabled) {
    return;
  }
  serverStartMs.set(label, performance.now());
  console.info(`[configure-timing] mark ${label}`);
}

export function markConfigureServerComplete(
  label: ConfigureTimingMark,
  startedAt: ConfigureTimingMark,
): void {
  if (!timingEnabled) {
    return;
  }
  const start = serverStartMs.get(startedAt);
  const durationMs =
    start === undefined ? undefined : Math.round(performance.now() - start);
  console.info(
    `[configure-timing] ${label}${
      durationMs === undefined ? "" : ` +${durationMs}ms`
    }`,
  );
}

export function markConfigureClient(label: ConfigureTimingMark): void {
  if (!timingEnabled || typeof window === "undefined") {
    return;
  }
  console.info(`[configure-timing] client ${label}`);
}

export type { ConfigureTimingMark };
