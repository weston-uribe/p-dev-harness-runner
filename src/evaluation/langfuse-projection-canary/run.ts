import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveSessionId } from "../identifiers.js";
import {
  createLangfuseApiClient,
  fetchSessionBundle,
} from "../langfuse-inspect/client.js";
import { buildInspectReport } from "../langfuse-inspect/report.js";
import {
  agentObservationDisplayName,
  aggregateGenerationDisplayName,
  phaseTraceDisplayName,
  sessionDisplayName,
} from "../naming.js";
import { createEvaluationRuntime, resolveEvaluationConfig } from "../runtime.js";
import { injectPhaseSkills } from "../../prompts/skill-inject.js";
import { resolveCostRecord } from "../telemetry/cost.js";
import { allowsLangfuseContentProjection } from "../telemetry/profiles.js";
import { boundRedactedContent } from "../telemetry/redact.js";
import { MAX_LANGFUSE_CONTENT_CHARS } from "../telemetry/bounds.js";
import {
  SYNTHETIC_PROJECTION_CANARY_SCHEMA_VERSION,
  type SyntheticProjectionCanaryReport,
} from "./types.js";

const SECRET_LIKE_MARKER = "sk-ant-api03-SYNTHETIC_SHOULD_REDACT";

export function listEvaluationConfigNamesPresent(
  env: NodeJS.ProcessEnv = process.env,
): SyntheticProjectionCanaryReport["configNamesPresent"] {
  return {
    langfusePublicKey: Boolean(env.LANGFUSE_PUBLIC_KEY?.trim()),
    langfuseSecretKey: Boolean(env.LANGFUSE_SECRET_KEY?.trim()),
    langfuseBaseUrl: Boolean(env.LANGFUSE_BASE_URL?.trim()),
    langfuseTracingEnvironment: Boolean(
      env.LANGFUSE_TRACING_ENVIRONMENT?.trim(),
    ),
    evaluationProvider: Boolean(env.P_DEV_EVALUATION_PROVIDER?.trim()),
    evaluationCaptureProfile: Boolean(
      env.P_DEV_EVALUATION_CAPTURE_PROFILE?.trim(),
    ),
    evaluationNamespace: Boolean(env.P_DEV_EVALUATION_NAMESPACE?.trim()),
  };
}

export function runPrivacyGateForContentProfile(params: {
  requestedProfile: string;
  sampleText: string;
}): {
  privacyGatePassed: boolean;
  privacyGateReason: string | null;
  effectiveProfile: "content-v1" | "metadata-v1";
  contentBodiesEnabled: boolean;
  redactedSample: string;
} {
  const requested =
    params.requestedProfile === "content-v1" ? "content-v1" : "metadata-v1";
  const redacted = boundRedactedContent(
    params.sampleText,
    MAX_LANGFUSE_CONTENT_CHARS,
  );
  if (requested === "content-v1") {
    if (!allowsLangfuseContentProjection("content-v1")) {
      return {
        privacyGatePassed: false,
        privacyGateReason: "content_profile_not_allowed",
        effectiveProfile: "metadata-v1",
        contentBodiesEnabled: false,
        redactedSample: redacted.text,
      };
    }
    if (redacted.text.includes(SECRET_LIKE_MARKER)) {
      return {
        privacyGatePassed: false,
        privacyGateReason: "secret_marker_not_redacted",
        effectiveProfile: "metadata-v1",
        contentBodiesEnabled: false,
        redactedSample: redacted.text,
      };
    }
    return {
      privacyGatePassed: true,
      privacyGateReason: null,
      effectiveProfile: "content-v1",
      contentBodiesEnabled: true,
      redactedSample: redacted.text,
    };
  }
  return {
    privacyGatePassed: true,
    privacyGateReason: null,
    effectiveProfile: "metadata-v1",
    contentBodiesEnabled: false,
    redactedSample: redacted.text,
  };
}

/** Linear-shaped key (`TEAM-123`) so inspect display-name parsing accepts it. */
export function buildSyntheticIssueKey(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `SYN-${stamp}`;
}

export async function runSyntheticProjectionCanary(options: {
  issueKey?: string;
  namespace?: string;
  apply?: boolean;
  outPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ report: SyntheticProjectionCanaryReport; exitCode: number }> {
  const env = options.env ?? process.env;
  const issueKey = (options.issueKey ?? buildSyntheticIssueKey()).trim();
  const namespace =
    options.namespace ??
    env.P_DEV_EVALUATION_NAMESPACE?.trim() ??
    "weston-dogfood";
  const sessionId = deriveSessionId(namespace, issueKey);
  const apply = options.apply === true;
  const requestedProfile =
    env.P_DEV_EVALUATION_CAPTURE_PROFILE?.trim() || "content-v1";

  const samplePrompt = [
    "Synthetic Complete Session canary prompt.",
    `Issue: ${issueKey}`,
    `Credential-like token that must never leave redaction: ${SECRET_LIKE_MARKER}`,
  ].join("\n");

  const privacy = runPrivacyGateForContentProfile({
    requestedProfile,
    sampleText: samplePrompt,
  });

  const skillInject = await injectPhaseSkills({
    phase: "planning",
    basePrompt: "Base planning prompt for synthetic canary.",
  });

  const cost = resolveCostRecord({
    modelId: "composer-2.5",
    modelParams: [{ id: "fast", value: "false" }],
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
  });

  const projected = {
    sessionDisplayName: sessionDisplayName(issueKey),
    phaseTraceName: phaseTraceDisplayName({ issueKey, phase: "planning" }),
    agentName: agentObservationDisplayName({ issueKey, role: "planner" }),
    generationName: aggregateGenerationDisplayName({
      issueKey,
      role: "planner",
      effectiveVariant: "standard",
    }),
    skillProvenanceStatus: skillInject.skillProvenanceStatus,
    costSource: cost.costSource,
    costUnavailableReason: cost.costUnavailableReason ?? null,
    costUsd:
      cost.estimatedCostUsd ?? cost.providerReportedCostUsd ?? null,
    effectiveVariant: "standard" as const,
  };

  let applied = false;
  let acceptanceComplete: boolean | null = null;

  if (apply) {
    if (!privacy.privacyGatePassed && requestedProfile === "content-v1") {
      // Fail closed: still may apply metadata-only if credentials resolve.
    }
    const resolved = resolveEvaluationConfig(env);
    if (!resolved.ok) {
      throw new Error(
        resolved.message ??
          "Langfuse credentials required for synthetic canary --apply",
      );
    }

    const runtime = await createEvaluationRuntime(env);
    try {
      const runId = `synthetic-canary-${createHash("sha256")
        .update(`${issueKey}:${Date.now()}`)
        .digest("hex")
        .slice(0, 12)}`;
      const handle = await runtime.startPhaseTrace({
        phase: "planning",
        issueKey,
        runId,
        revisionCycleIndex: null,
        linearTeamKey: null,
        metadata: {
          syntheticCanary: true,
          sessionDisplayName: projected.sessionDisplayName,
          captureProfileEffective: privacy.effectiveProfile,
        },
      });
      if (!handle) {
        throw new Error("Evaluation runtime returned no phase handle");
      }

      const agent = handle.startChild(projected.agentName, "agent");
      const gen = agent.startChild(projected.generationName, "generation");
      const promptBody = privacy.contentBodiesEnabled
        ? privacy.redactedSample.slice(0, MAX_LANGFUSE_CONTENT_CHARS)
        : undefined;
      const outputBody = privacy.contentBodiesEnabled
        ? boundRedactedContent(
            "Synthetic planner output for Complete Session canary.",
            MAX_LANGFUSE_CONTENT_CHARS,
          ).text
        : undefined;

      gen.end({
        model: "composer-2.5",
        usageDetails: { input: 12, output: 4, total: 16 },
        metadata: {
          syntheticCanary: true,
          linearIssueKey: issueKey,
          phase: "planning",
          harnessRunId: runId,
          usageAggregation: "cursor_run_aggregate",
          individualModelCallsAvailable: false,
          costSource: cost.costSource,
          costUnavailableReason: cost.costUnavailableReason ?? null,
          pricingRegistryVersion: cost.pricingRegistryVersion ?? null,
          costUsd:
            cost.providerReportedCostUsd ?? cost.estimatedCostUsd ?? null,
          modelId: "composer-2.5",
          skillsUsed: skillInject.skillsUsed.map((s) => ({
            skillId: s.skillId,
            sourcePath: s.sourcePath,
            role: s.role,
            contentSha256: s.contentSha256,
            inclusionMethod: s.inclusionMethod,
          })),
          skillProvenanceStatus: skillInject.skillProvenanceStatus,
          promptName: "synthetic-planning-canary",
          promptContractVersion: "canary-v1",
        },
        ...(promptBody ? { input: promptBody } : {}),
        ...(outputBody ? { output: outputBody } : {}),
      });
      agent.end({
        metadata: {
          syntheticCanary: true,
          linearIssueKey: issueKey,
          agentRole: "planner",
          skillsUsed: skillInject.skillsUsed.map((s) => ({
            skillId: s.skillId,
            inclusionMethod: s.inclusionMethod,
          })),
          skillProvenanceStatus: skillInject.skillProvenanceStatus,
        },
      });
      handle.finish(
        {
          finalOutcome: "success",
          errorClassification: null,
          linearStatusAfter: null,
          prCreated: false,
          previewAvailable: false,
          changedFileCount: 0,
        },
        { syntheticCanary: true },
      );
      runtime.recordScore({
        id: createHash("sha256")
          .update(`synthetic:phase_success:${handle.correlation.traceId}`)
          .digest("hex"),
        target: "trace",
        traceId: handle.correlation.traceId,
        sessionId: handle.correlation.sessionId,
        name: "phase_success",
        dataType: "BOOLEAN",
        value: true,
        timestamp: new Date().toISOString(),
      });
      applied = true;
    } finally {
      await runtime.flushAndShutdown();
    }

    // Langfuse read API is eventually consistent after OTEL flush
    await new Promise((r) => setTimeout(r, 20_000));
    const client = await createLangfuseApiClient(resolved.config);
    const bundle = await fetchSessionBundle(client, sessionId);
    const inspect = buildInspectReport({
      issueKey,
      namespace,
      sessionId,
      session: bundle.session,
      traces: bundle.traces,
      observations: bundle.observations,
      scores: bundle.scores,
      // Synthetic canary projects planning only.
      expectedPhases: ["planning"],
    });
    acceptanceComplete = inspect.acceptance.coreComplete;
  }

  const report: SyntheticProjectionCanaryReport = {
    schemaVersion: SYNTHETIC_PROJECTION_CANARY_SCHEMA_VERSION,
    mode: apply ? "apply" : "dry-run",
    issueKey,
    namespace,
    sessionId,
    captureProfile: privacy.effectiveProfile,
    contentBodiesEnabled: privacy.contentBodiesEnabled,
    privacyGatePassed: privacy.privacyGatePassed,
    privacyGateReason: privacy.privacyGateReason,
    configNamesPresent: listEvaluationConfigNamesPresent(env),
    projected,
    applied,
    acceptanceComplete,
    inspectedAt: new Date().toISOString(),
  };

  if (options.outPath) {
    const out = path.resolve(options.outPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (apply) {
    const exit =
      applied &&
      acceptanceComplete === true &&
      (privacy.privacyGatePassed || privacy.effectiveProfile === "metadata-v1")
        ? 0
        : 2;
    return { report, exitCode: exit };
  }

  // Dry-run: require privacy gate for content requests; otherwise metadata plan is OK
  const dryOk =
    privacy.effectiveProfile === "metadata-v1" || privacy.privacyGatePassed;
  return { report, exitCode: dryOk ? 0 : 2 };
}
