import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Vercel recovery embed + single controller", () => {
  const editor = readSource(
    "apps/gui/components/settings/editors/connections-settings-editor.tsx",
  );
  const panel = readSource(
    "apps/gui/components/settings/vercel-recovery-panel.tsx",
  );
  const form = readSource(
    "apps/gui/components/custom/environment-config-form.tsx",
  );

  it("Connections editor does not start recovery on token save", () => {
    expect(editor).not.toContain("startVercelRecoveryAfterTokenSave");
    expect(editor).not.toContain(
      "/api/setup/vercel-connection-recovery/start",
    );
    expect(editor).toContain("setRecoveryActive(true)");
    expect(editor).toContain("Activate embedded controller only");
  });

  it("resumes durable nonterminal ops on Connections load", () => {
    expect(editor).toContain(
      "/api/setup/vercel-connection-recovery/status",
    );
    expect(editor).toContain("setRecoveryActive(true)");
    expect(editor).toContain("expandedContent");
    expect(editor).toContain('variant="embedded"');
  });

  it("embeds recovery in Vercel card and removes detached panel", () => {
    expect(editor).toContain("VercelRecoveryPanel");
    expect(editor).toContain("VERCEL_TOKEN:");
    // Detached bottom panel pattern removed — only expandedContent host.
    expect(editor).not.toMatch(
      /<\/EnvironmentConfigForm>\s*<VercelRecoveryPanel/,
    );
    expect(form).toContain("expandedContent");
    expect(form).toContain("AnimatePresence");
    expect(form).toContain("useReducedMotion");
    expect(form).toContain("data-expanded-content");
  });

  it("panel owns single-flight mutate and invariant UI", () => {
    expect(panel).toContain("flightRef");
    expect(panel).toContain("runExclusive");
    expect(panel).toContain("data-recovery-progress");
    expect(panel).toContain("data-recovery-input");
    expect(panel).toContain("data-recovery-failure");
    expect(panel).toContain("invariantOk");
    expect(panel).toContain('variant === "embedded"');
    expect(panel).toContain("select-scope");
    expect(panel).toContain("select-bridge");
    expect(panel).toContain("expectedRevision");
  });

  it("does not export editor-facing start helper", () => {
    expect(panel).not.toContain("export async function startVercelRecovery");
    expect(panel).not.toContain("startVercelRecoveryAfterTokenSave");
  });
});
