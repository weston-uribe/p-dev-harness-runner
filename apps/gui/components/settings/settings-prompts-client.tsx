"use client";

import { useEffect, useState } from "react";

type PromptConfigView = {
  provider: string;
  label: string | null;
  version: number | null;
  preferredSkillMode: string;
  nativeCapabilityState: string;
  nativeExecutionAvailable: boolean;
  notes: string[];
};

export function SettingsPromptsClient() {
  const [view, setView] = useState<PromptConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/prompt-config", {
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as PromptConfigView;
        if (!cancelled) setView(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Prompts and skills</h1>
        <p className="text-sm text-red-600">Failed to load configuration: {error}</p>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Prompts and skills</h1>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="settings-prompts">
      <div>
        <h1 className="text-xl font-semibold">Prompts and skills</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only view of prompt provider and skill execution policy. This page
          does not write configuration.
        </p>
      </div>

      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="font-medium">Prompt provider</dt>
          <dd data-testid="prompt-provider">{view.provider}</dd>
        </div>
        <div>
          <dt className="font-medium">Approved label / version</dt>
          <dd data-testid="prompt-label-version">
            {view.label ?? "—"}
            {view.version != null ? ` / v${view.version}` : ""}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Preferred skill mode</dt>
          <dd data-testid="preferred-skill-mode">{view.preferredSkillMode}</dd>
        </div>
        <div>
          <dt className="font-medium">Native Cursor skill capability</dt>
          <dd data-testid="native-capability-state">
            {view.nativeCapabilityState}
            {" — "}
            {view.nativeExecutionAvailable
              ? "available"
              : "not available (unproven for SDK Cloud Agents)"}
          </dd>
        </div>
      </dl>

      <div
        className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
        data-testid="native-skill-unavailable-notice"
      >
        Native Cursor skill execution is not offered as an enabled option. Production
        runs use rendered skill text from <code>.agents/skills</code> until a final
        remote canary proves discovery and invocation.
      </div>

      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {view.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
