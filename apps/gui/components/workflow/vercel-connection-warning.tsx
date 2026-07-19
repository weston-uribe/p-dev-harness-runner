"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CONNECTIONS_VERCEL_REPAIR_ROUTE } from "@harness/setup/gui-routes";
import type { CredentialHealthStatus } from "@harness/setup/workspace-health";

type SavedCredentialHealth = {
  status: CredentialHealthStatus;
  message?: string;
};

/**
 * Visible when Workflow opens with a verified durable bridge but degraded
 * Vercel credential health (e.g. revoked token). Does not block Workflow.
 */
export function VercelConnectionWarning() {
  const [health, setHealth] = useState<SavedCredentialHealth | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/setup/verify-saved-connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "VERCEL_TOKEN" }),
        });
        if (!response.ok) {
          // Local runtime / module failures must not look like bad credentials.
          const contentType = response.headers.get("content-type");
          setHealth({
            status:
              response.status >= 500 ||
              contentType?.includes("text/html")
                ? "local_runtime_error"
                : "unknown",
            message:
              response.status >= 500
                ? "Local GUI runtime error while verifying Vercel connection."
                : "Unable to verify Vercel connection.",
          });
          return;
        }
        const body = (await response.json()) as {
          health?: SavedCredentialHealth;
        };
        if (body.health) {
          setHealth(body.health);
        }
      } catch {
        // Non-blocking warning.
      }
    })();
  }, []);

  if (!health) {
    return null;
  }
  if (health.status === "local_runtime_error") {
    return (
      <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
        <p className="font-medium">Local GUI runtime error</p>
        <p className="mt-1 text-muted-foreground">
          Connection verification could not run because the local GUI runtime
          failed. This does not mean your Vercel credentials are invalid.
          Restart with <code className="text-xs">p-dev</code> or{" "}
          <code className="text-xs">npm start</code>, or run{" "}
          <code className="text-xs">npm run harness:gui:doctor</code>.
        </p>
      </div>
    );
  }
  if (
    health.status !== "unauthorized" &&
    health.status !== "credential_invalid" &&
    health.status !== "unknown" &&
    health.status !== "provider_unavailable" &&
    health.status !== "bridge_unreachable"
  ) {
    return null;
  }

  const label =
    health.status === "unauthorized" || health.status === "credential_invalid"
      ? "Unauthorized"
      : "Unable to verify";

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
      <p className="font-medium">Vercel connection: {label}</p>
      <p className="mt-1 text-muted-foreground">
        Automation may keep running on the existing bridge, but you should
        reconnect Vercel.
      </p>
      <Link
        href={CONNECTIONS_VERCEL_REPAIR_ROUTE}
        className="mt-2 inline-block font-medium text-foreground underline underline-offset-4"
      >
        Repair in Settings → Connections
      </Link>
    </div>
  );
}
