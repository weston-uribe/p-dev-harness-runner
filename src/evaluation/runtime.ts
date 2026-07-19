import {
  EVALUATION_CAPTURE_PROFILE_METADATA,
  EVALUATION_PROVIDER_LANGFUSE,
  type EvaluationCaptureProfile,
  type EvaluationRuntime,
  type EvaluationRuntimeConfig,
  type PhaseTraceHandle,
  type StartPhaseTraceInput,
} from "./types.js";
import { isKnownCaptureProfile } from "./telemetry/profiles.js";
import { warnOnce } from "./warn.js";

export {
  warnOnce,
  withFlushTimeout,
  resetEvaluationWarningsForTests,
  FLUSH_TIMEOUT_MS,
} from "./warn.js";

export function createNoopRuntime(): EvaluationRuntime {
  return {
    enabled: false,
    namespace: "default",
    async startPhaseTrace(
      _input: StartPhaseTraceInput,
    ): Promise<PhaseTraceHandle | null> {
      return null;
    },
    recordScore(_input): void {},
    async flushAndShutdown(): Promise<void> {},
  };
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve evaluation config from environment.
 * - provider absent → silent no-op (`reason: "absent"`)
 * - invalid config → warn + no-op (`reason: "invalid"`)
 */
export function resolveEvaluationConfig(
  env: NodeJS.ProcessEnv = process.env,
):
  | { ok: true; config: EvaluationRuntimeConfig }
  | { ok: false; reason: "absent" | "invalid"; message?: string } {
  const provider = readEnv(env, "P_DEV_EVALUATION_PROVIDER");
  if (!provider) {
    return { ok: false, reason: "absent" };
  }

  if (provider !== EVALUATION_PROVIDER_LANGFUSE) {
    return {
      ok: false,
      reason: "invalid",
      message: `Unknown evaluation provider "${provider}"; falling back to no-op`,
    };
  }

  const captureProfileRaw =
    readEnv(env, "P_DEV_EVALUATION_CAPTURE_PROFILE") ??
    EVALUATION_CAPTURE_PROFILE_METADATA;
  if (!isKnownCaptureProfile(captureProfileRaw)) {
    return {
      ok: false,
      reason: "invalid",
      message: `Unknown evaluation capture profile "${captureProfileRaw}"; falling back to no-op`,
    };
  }
  const captureProfile: EvaluationCaptureProfile = captureProfileRaw;

  const publicKey = readEnv(env, "LANGFUSE_PUBLIC_KEY");
  const secretKey = readEnv(env, "LANGFUSE_SECRET_KEY");
  if (!publicKey || !secretKey) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "Langfuse evaluation enabled but LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY missing; falling back to no-op",
    };
  }

  const namespace = readEnv(env, "P_DEV_EVALUATION_NAMESPACE") ?? "default";
  const baseUrl =
    readEnv(env, "LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com";
  const tracingEnvironment =
    readEnv(env, "LANGFUSE_TRACING_ENVIRONMENT") ?? "default";
  const release = readEnv(env, "LANGFUSE_RELEASE") ?? null;

  return {
    ok: true,
    config: {
      provider: EVALUATION_PROVIDER_LANGFUSE,
      captureProfile,
      namespace,
      publicKey,
      secretKey,
      baseUrl,
      tracingEnvironment,
      release,
    },
  };
}

export type LangfuseRuntimeFactory = (
  config: EvaluationRuntimeConfig,
) => Promise<EvaluationRuntime>;

let langfuseFactory: LangfuseRuntimeFactory | null = null;

/** Test seam for injecting a Langfuse runtime without dynamic import. */
export function setLangfuseRuntimeFactoryForTests(
  factory: LangfuseRuntimeFactory | null,
): void {
  langfuseFactory = factory;
}

export async function createEvaluationRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EvaluationRuntime> {
  try {
    const resolved = resolveEvaluationConfig(env);
    if (!resolved.ok) {
      if (resolved.reason === "invalid" && resolved.message) {
        warnOnce(`config:${resolved.message}`, resolved.message);
      }
      return createNoopRuntime();
    }

    const factory =
      langfuseFactory ??
      (async (config) => {
        const mod = await import("./langfuse-runtime.js");
        return mod.createLangfuseRuntime(config);
      });

    return await factory(resolved.config);
  } catch (error) {
    warnOnce(
      "create-runtime",
      `Evaluation runtime init failed; falling back to no-op: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createNoopRuntime();
  }
}
