import type { WorkflowBootstrapPayload } from "@harness/workflow-page/types";

function buildQuery(input?: {
  sourceMode?: string;
  fixtureId?: string;
  scopeId?: string;
}): string {
  const params = new URLSearchParams();
  if (input?.sourceMode === "fixture" && input.fixtureId) {
    params.set("source", "fixture");
    params.set("fixture", input.fixtureId);
  }
  if (input?.scopeId) {
    params.set("scope", input.scopeId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchWorkflowBootstrap(input?: {
  sourceMode?: string;
  fixtureId?: string;
  scopeId?: string;
  signal?: AbortSignal;
}): Promise<WorkflowBootstrapPayload> {
  const response = await fetch(`/api/workflow/bootstrap${buildQuery(input)}`, {
    signal: input?.signal,
  });
  if (!response.ok) {
    throw new Error("Failed to load Workflow bootstrap data.");
  }
  return (await response.json()) as WorkflowBootstrapPayload;
}

export async function saveWorkflowModel(input: {
  role: "planner" | "builder" | "planReviewer" | "codeReviewer" | "codeReviser";
  modelId: string;
  params: Array<{ id: string; value: string }>;
  expectedConfigFingerprint: string;
  sourceMode?: string;
  fixtureId?: string;
  scopeId?: string;
  sequenceId?: number;
}): Promise<{
  configFingerprint: string;
  savedAt: string;
  sequenceId?: number;
}> {
  const response = await fetch(
    `/api/workflow/models${buildQuery(input)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: input.role,
        modelId: input.modelId,
        params: input.params,
        expectedConfigFingerprint: input.expectedConfigFingerprint,
        sourceMode: input.sourceMode,
        fixtureId: input.fixtureId,
        scopeId: input.scopeId,
      }),
    },
  );
  const payload = (await response.json()) as {
    saved?: boolean;
    configFingerprint?: string;
    savedAt?: string;
    error?: string;
    code?: string;
  };
  if (!response.ok || !payload.saved || !payload.configFingerprint) {
    const error = new Error(payload.error ?? "Couldn't save model settings.") as Error & {
      code?: string;
    };
    error.code = payload.code;
    throw error;
  }
  return {
    configFingerprint: payload.configFingerprint,
    savedAt: payload.savedAt ?? new Date().toISOString(),
    sequenceId: input.sequenceId,
  };
}

export async function saveWorkflowOptionalPhases(input: {
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
  expectedConfigFingerprint: string;
  sourceMode?: string;
  fixtureId?: string;
  scopeId?: string;
}): Promise<{
  configFingerprint: string;
  savedAt: string;
}> {
  const response = await fetch(
    `/api/workflow/optional-phases${buildQuery(input)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planReviewEnabled: input.planReviewEnabled,
        planReviewCycleLimit: input.planReviewCycleLimit,
        codeReviewEnabled: input.codeReviewEnabled,
        codeReviewCycleLimit: input.codeReviewCycleLimit,
        expectedConfigFingerprint: input.expectedConfigFingerprint,
        sourceMode: input.sourceMode,
        fixtureId: input.fixtureId,
        scopeId: input.scopeId,
      }),
    },
  );
  const payload = (await response.json()) as {
    saved?: boolean;
    configFingerprint?: string;
    savedAt?: string;
    error?: string;
    code?: string;
  };
  if (!response.ok || !payload.saved || !payload.configFingerprint) {
    const error = new Error(payload.error ?? "Couldn't save workflow settings.") as Error & {
      code?: string;
    };
    error.code = payload.code;
    throw error;
  }
  return {
    configFingerprint: payload.configFingerprint,
    savedAt: payload.savedAt ?? new Date().toISOString(),
  };
}
