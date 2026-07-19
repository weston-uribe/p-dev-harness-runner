import { NextResponse } from "next/server";
import { buildPromptConfigView } from "@harness/prompts/config-view";
import { loadHarnessConfig } from "@harness/config/load-config";
import { toPublicApiError } from "@harness/gui/public-client-payload";

/**
 * GET-only prompt/skill configuration view.
 * Must not write harness.config.json or environment state.
 */
export async function GET() {
  try {
    let provider: "local" | "langfuse_with_local_fallback" | undefined;
    let label: string | null | undefined;
    let version: number | null | undefined;
    let preferredSkillMode:
      | "automatic"
      | "native_when_supported"
      | "rendered_fallback"
      | undefined;

    try {
      const loaded = await loadHarnessConfig();
      const pp = loaded.config.promptProvider;
      provider = pp?.provider;
      label = pp?.label ?? null;
      version = pp?.version ?? null;
      preferredSkillMode = pp?.preferredSkillMode;
    } catch {
      // Fall back to env/defaults when config is unavailable in GUI context.
    }

    const view = buildPromptConfigView({
      provider,
      label,
      version,
      preferredSkillMode,
    });
    return NextResponse.json(view);
  } catch (error) {
    const publicError = toPublicApiError(error, {
      fallbackCode: "prompt_config_read_failed",
      fallbackMessage: "Failed to read prompt configuration.",
    });
    return NextResponse.json(
      {
        error: publicError.message,
        code: publicError.code,
      },
      { status: 500 },
    );
  }
}
