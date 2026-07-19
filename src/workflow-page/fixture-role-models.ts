import type { HarnessConfig } from "../config/types.js";
import type { RoleModelRole } from "../config/role-models.js";
import { buildConfigFingerprint } from "./bootstrap.js";

const fixtureRoleModels = new Map<string, HarnessConfig["roleModels"]>();

function storageKey(fixtureId: string, scopeId: string): string {
  return `${fixtureId}::${scopeId}`;
}

export function getFixtureRoleModels(
  fixtureId: string,
  scopeId: string,
): HarnessConfig["roleModels"] | null {
  return fixtureRoleModels.get(storageKey(fixtureId, scopeId)) ?? null;
}

export function saveFixtureRoleModel(input: {
  fixtureId: string;
  scopeId: string;
  baseConfig: HarnessConfig;
  role: RoleModelRole;
  modelId: string;
  params: Array<{ id: string; value: string }>;
}): { configFingerprint: string; roleModels: HarnessConfig["roleModels"] } {
  const key = storageKey(input.fixtureId, input.scopeId);
  const current = fixtureRoleModels.get(key) ?? input.baseConfig.roleModels ?? {};
  const selection = input.params.length
    ? { id: input.modelId, params: input.params }
    : { id: input.modelId };
  const next = {
    ...current,
    [input.role]: selection,
  };
  fixtureRoleModels.set(key, next);

  const mergedConfig: HarnessConfig = {
    ...input.baseConfig,
    roleModels: next,
  };

  return {
    configFingerprint: buildConfigFingerprint(mergedConfig),
    roleModels: next,
  };
}

export function resetFixtureRoleModelsForTests(): void {
  fixtureRoleModels.clear();
}
