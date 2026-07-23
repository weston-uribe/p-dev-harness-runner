"use client";

import type { CursorUsageConfigResponse } from "@/lib/cursor-usage-client";

interface DiscoveryConfigPanelProps {
  config: CursorUsageConfigResponse | null;
}

export function DiscoveryConfigPanel({ config }: DiscoveryConfigPanelProps) {
  if (!config) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="cursor-usage-config-loading">
        Loading Langfuse discovery configuration…
      </p>
    );
  }

  const ready = config.configurationStatus === "ready";
  const namespaceLabel = config.namespaceConfigured
    ? (config.namespace ?? "not set")
    : "not set";
  const environmentLabel = config.environmentFilterExplicit
    ? (config.environment ?? "not set")
    : "All environments";

  return (
    <div
      className="rounded-md border px-4 py-3 text-sm space-y-1"
      data-testid="cursor-usage-discovery-config"
      data-config-status={config.configurationStatus}
    >
      <p>
        Langfuse configured:{" "}
        <span
          className="font-medium text-foreground"
          data-testid="cursor-usage-langfuse-configured"
        >
          {config.langfuseConfigured ? "yes" : "no"}
        </span>
      </p>
      <p>
        Namespace:{" "}
        <span
          className="font-medium text-foreground"
          data-testid="cursor-usage-config-namespace"
        >
          {namespaceLabel}
        </span>
      </p>
      <p>
        Environment filter:{" "}
        <span
          className="font-medium text-foreground"
          data-testid="cursor-usage-config-environment"
        >
          {environmentLabel}
        </span>
      </p>
      <p>
        Host:{" "}
        <span
          className="font-medium text-foreground"
          data-testid="cursor-usage-config-host"
        >
          {config.langfuseHost ?? "—"}
        </span>
      </p>
      {!ready ? (
        <p
          className="text-destructive"
          role="alert"
          data-testid="cursor-usage-config-error"
          data-error-code={config.errorCode ?? ""}
        >
          {config.errorMessage ??
            "Cursor usage discovery configuration is not ready."}
        </p>
      ) : null}
    </div>
  );
}
