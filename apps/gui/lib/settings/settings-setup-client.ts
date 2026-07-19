import { readSetupJsonResponse } from "@/lib/setup-json-response";
import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import type {
  AutomationSettingsPatch,
  SettingsConfigPatch,
} from "@harness/setup/settings-config-patch";
import type {
  LinearWorkspaceApplyResult,
  LinearWorkspacePlanInput,
} from "@harness/setup/linear-workspace-apply";
import type {
  LinearSetupPlanInput,
  LinearSetupPreview,
  LinearSetupApplyResult,
} from "@harness/setup/linear-setup-apply";
import type { VercelBridgePreview } from "@harness/setup/vercel-setup-apply";
import type { LocalEnvFormInput } from "@harness/setup/local-apply-actions";

export async function previewConnectServices(env: LocalEnvFormInput) {
  const response = await fetch("/api/setup/preview-connect-services", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  return readSetupJsonResponse<{
    fingerprint: string;
    validationError?: string;
  }>(response, "POST /api/setup/preview-connect-services");
}

export async function applyConnectServices(input: {
  env: LocalEnvFormInput;
  fingerprint: string;
}) {
  const response = await fetch("/api/setup/apply-connect-services", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      env: input.env,
      confirmed: true,
      fingerprint: input.fingerprint,
    }),
  });
  return readSetupJsonResponse<{ summary: unknown }>(
    response,
    "POST /api/setup/apply-connect-services",
  );
}

export async function verifyService(input: {
  service: "linear" | "cursor" | "github" | "vercel";
  token?: string;
}) {
  const response = await fetch("/api/setup/verify-service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readSetupJsonResponse<{
    status: "connected" | "failed" | "unknown";
    message?: string;
    limitation?: string;
    label?: string;
  }>(response, "POST /api/setup/verify-service");
}

export async function previewLinearSetup(
  plan: Omit<LinearSetupPlanInput, "linearApiKey"> & { linearApiKey?: string },
) {
  const response = await fetch("/api/setup/preview-linear-setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  return readSetupJsonResponse<LinearSetupPreview>(
    response,
    "POST /api/setup/preview-linear-setup",
  );
}

export async function applyLinearWorkspace(input: {
  plan: Omit<LinearWorkspacePlanInput, "linearApiKey"> & {
    linearApiKey?: string;
  };
  fingerprint?: string;
}) {
  const response = await fetch("/api/setup/apply-linear-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan: input.plan,
      confirmed: true,
      fingerprint: input.fingerprint,
    }),
  });
  return readSetupJsonResponse<{
    apply: LinearWorkspaceApplyResult;
    summary: unknown;
    expectedCommittedFingerprint: string;
  }>(response, "POST /api/setup/apply-linear-workspace");
}

export async function previewLinearWorkspace(
  plan: Omit<LinearWorkspacePlanInput, "linearApiKey"> & {
    linearApiKey?: string;
  },
) {
  const response = await fetch("/api/setup/preview-linear-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  return readSetupJsonResponse<import("@harness/setup/linear-workspace-plan").LinearWorkspacePreview>(
    response,
    "POST /api/setup/preview-linear-workspace",
  );
}

export async function applyLinearSetup(input: {
  plan: Omit<LinearSetupPlanInput, "linearApiKey"> & { linearApiKey?: string };
  fingerprint: string;
}) {
  const response = await fetch("/api/setup/apply-linear-setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan: input.plan,
      confirmed: true,
      fingerprint: input.fingerprint,
    }),
  });
  return readSetupJsonResponse<{ apply: LinearSetupApplyResult; summary: unknown }>(
    response,
    "POST /api/setup/apply-linear-setup",
  );
}

export async function previewVercelBridge(body: Record<string, unknown>) {
  const response = await fetch("/api/setup/preview-vercel-bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readSetupJsonResponse<VercelBridgePreview>(
    response,
    "POST /api/setup/preview-vercel-bridge",
  );
}

export async function applyVercelBridge(input: {
  plan: Record<string, unknown>;
  fingerprint: string;
}) {
  const response = await fetch("/api/setup/apply-vercel-bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan: input.plan,
      confirmed: true,
      fingerprint: input.fingerprint,
    }),
  });
  return readSetupJsonResponse<{ apply: { verified?: boolean }; summary: unknown }>(
    response,
    "POST /api/setup/apply-vercel-bridge",
  );
}

let runnerUpgradeStatusAbort: AbortController | null = null;

export function abortInFlightRunnerUpgradeStatusFetch(): void {
  if (runnerUpgradeStatusAbort) {
    runnerUpgradeStatusAbort.abort();
    runnerUpgradeStatusAbort = null;
  }
}

export async function fetchRunnerUpgradeStatus(options?: {
  signal?: AbortSignal;
}): Promise<
  import("@harness/setup/runner-upgrade-types").RunnerUpgradeStatusResult
> {
  abortInFlightRunnerUpgradeStatusFetch();
  const controller = new AbortController();
  runnerUpgradeStatusAbort = controller;
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
    }
  }
  try {
    const response = await fetch("/api/setup/runner-upgrade-status", {
      signal: controller.signal,
    });
    return await readSetupJsonResponse<
      import("@harness/setup/runner-upgrade-types").RunnerUpgradeStatusResult
    >(response, "GET /api/setup/runner-upgrade-status");
  } finally {
    if (runnerUpgradeStatusAbort === controller) {
      runnerUpgradeStatusAbort = null;
    }
  }
}

export async function previewRunnerUpgrade() {
  const response = await fetch("/api/setup/preview-runner-upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return readSetupJsonResponse<
    import("@harness/setup/runner-upgrade-types").RunnerUpgradePreviewResult
  >(response, "POST /api/setup/preview-runner-upgrade");
}

export async function applyRunnerUpgrade(input: {
  previewFingerprint?: string;
  resume?: boolean;
}) {
  const response = await fetch("/api/setup/apply-runner-upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmed: true,
      previewFingerprint: input.previewFingerprint,
      resume: input.resume === true,
    }),
  });
  const bodyText = await response.text();
  if (response.status !== 202) {
    let message = `Setup request failed: POST /api/setup/apply-runner-upgrade returned HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      if (parsed.error) {
        message = parsed.error;
      }
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  if (!bodyText.trim()) {
    throw new Error(
      "Setup request failed: POST /api/setup/apply-runner-upgrade returned an empty response body",
    );
  }
  return JSON.parse(bodyText) as {
    apply: import("@harness/setup/runner-upgrade-types").RunnerUpgradeAcceptResult;
    progress: import("@harness/setup/runner-upgrade-progress").RunnerUpgradeProgressState;
    status: import("@harness/setup/runner-upgrade-types").RunnerUpgradeStatusResult;
  };
}

export async function fetchRunnerUpgradeProgress() {
  const response = await fetch("/api/setup/runner-upgrade-progress");
  return readSetupJsonResponse<{
    progress: import("@harness/setup/runner-upgrade-progress").RunnerUpgradeProgressState | null;
  }>(response, "GET /api/setup/runner-upgrade-progress").then(
    (payload) => payload.progress,
  );
}

export async function previewSettingsConfigPatch(input: {
  patch: SettingsConfigPatch;
  verifyBranches?: boolean;
  requireDistinctBranches?: boolean;
}) {
  const response = await fetch("/api/settings/preview-config-patch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patch: input.patch,
      verifyBranches: input.verifyBranches,
      requireDistinctBranches: input.requireDistinctBranches,
    }),
  });
  return readSetupJsonResponse<{
    fingerprint: string;
    configPreview: string;
  }>(response, "POST /api/settings/preview-config-patch");
}

export async function applySettingsConfigPatch(input: {
  patch: SettingsConfigPatch;
  expectedConfigFingerprint: string;
  verifyBranches?: boolean;
  requireDistinctBranches?: boolean;
}) {
  const response = await fetch("/api/settings/apply-config-patch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patch: input.patch,
      expectedConfigFingerprint: input.expectedConfigFingerprint,
      confirmed: true,
      verifyBranches: input.verifyBranches,
      requireDistinctBranches: input.requireDistinctBranches,
    }),
  });
  return readSetupJsonResponse<{
    configFingerprint: string;
  }>(response, "POST /api/settings/apply-config-patch");
}

export type { AutomationSettingsPatch, LocalConfigFormInput };
