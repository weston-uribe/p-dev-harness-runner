import type {
  EvaluatorDefinition,
  EvaluatorDependency,
} from "./types.js";
import { getImplementationHash } from "./manifest.js";

const registry = new Map<string, EvaluatorDefinition>();
let dagValidated = false;
let topoOrder: string[] | null = null;

function keyOf(evaluatorId: string, evaluatorVersion: string): string {
  return `${evaluatorId}@${evaluatorVersion}`;
}

export type EvaluatorDefinitionInput = Omit<
  EvaluatorDefinition,
  "implementationHash"
> & {
  implementationHash?: string;
};

export async function registerEvaluator(
  definition: EvaluatorDefinitionInput,
): Promise<EvaluatorDefinition> {
  const implementationHash =
    definition.implementationHash ??
    (await getImplementationHash(
      definition.evaluatorId,
      definition.evaluatorVersion,
    ));
  const full: EvaluatorDefinition = { ...definition, implementationHash };
  const key = keyOf(full.evaluatorId, full.evaluatorVersion);
  if (registry.has(key)) {
    throw new Error(`Duplicate evaluator registration: ${key}`);
  }
  // Uniqueness of evaluatorId across versions is allowed; same id+version is not.
  registry.set(key, full);
  dagValidated = false;
  topoOrder = null;
  return full;
}

export function clearEvaluatorRegistryForTests(): void {
  registry.clear();
  dagValidated = false;
  topoOrder = null;
  resetRegistrationFlagForTests();
}

let resetRegistrationFlagForTests: () => void = () => {};

export function setRegistrationResetHookForTests(fn: () => void): void {
  resetRegistrationFlagForTests = fn;
}

export function listRegisteredEvaluators(): EvaluatorDefinition[] {
  return [...registry.values()].sort((a, b) => {
    const c = a.evaluatorId.localeCompare(b.evaluatorId);
    return c !== 0 ? c : a.dimensionId.localeCompare(b.dimensionId);
  });
}

export function getEvaluator(
  evaluatorId: string,
  evaluatorVersion: string,
): EvaluatorDefinition | null {
  return registry.get(keyOf(evaluatorId, evaluatorVersion)) ?? null;
}

export function getEvaluatorsById(evaluatorId: string): EvaluatorDefinition[] {
  return listRegisteredEvaluators().filter((e) => e.evaluatorId === evaluatorId);
}

function validateDependencies(definitions: EvaluatorDefinition[]): void {
  const byId = new Map<string, EvaluatorDefinition[]>();
  for (const def of definitions) {
    const list = byId.get(def.evaluatorId) ?? [];
    list.push(def);
    byId.set(def.evaluatorId, list);
  }
  for (const def of definitions) {
    for (const dep of def.dependencies) {
      const candidates = byId.get(dep.evaluatorId) ?? [];
      const ok = candidates.some((c) =>
        dep.acceptableVersions.includes(c.evaluatorVersion),
      );
      if (!ok) {
        throw new Error(
          `Evaluator ${def.evaluatorId}@${def.evaluatorVersion} dependency unsatisfied: ${dep.evaluatorId} versions [${dep.acceptableVersions.join(",")}]`,
        );
      }
    }
  }
}

function detectCycle(definitions: EvaluatorDefinition[]): void {
  const nodes = definitions.map((d) => keyOf(d.evaluatorId, d.evaluatorVersion));
  const edges = new Map<string, string[]>();
  for (const def of definitions) {
    const from = keyOf(def.evaluatorId, def.evaluatorVersion);
    const tos: string[] = [];
    for (const dep of def.dependencies) {
      for (const d of definitions) {
        if (
          d.evaluatorId === dep.evaluatorId &&
          dep.acceptableVersions.includes(d.evaluatorVersion)
        ) {
          tos.push(keyOf(d.evaluatorId, d.evaluatorVersion));
        }
      }
    }
    edges.set(from, tos);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new Error(`Evaluator dependency cycle detected at ${node}`);
    }
    visiting.add(node);
    for (const next of edges.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of nodes) visit(node);
}

export function validateRegistryDag(): string[] {
  const definitions = listRegisteredEvaluators();
  validateDependencies(definitions);
  detectCycle(definitions);

  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const def of definitions) {
    const k = keyOf(def.evaluatorId, def.evaluatorVersion);
    indegree.set(k, indegree.get(k) ?? 0);
    edges.set(k, edges.get(k) ?? []);
  }
  for (const def of definitions) {
    const to = keyOf(def.evaluatorId, def.evaluatorVersion);
    for (const dep of def.dependencies) {
      for (const d of definitions) {
        if (
          d.evaluatorId === dep.evaluatorId &&
          dep.acceptableVersions.includes(d.evaluatorVersion)
        ) {
          const from = keyOf(d.evaluatorId, d.evaluatorVersion);
          edges.get(from)!.push(to);
          indegree.set(to, (indegree.get(to) ?? 0) + 1);
        }
      }
    }
  }
  const queue = [...indegree.entries()]
    .filter(([, n]) => n === 0)
    .map(([k]) => k)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of (edges.get(node) ?? []).sort()) {
      const nextDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
      queue.sort();
    }
  }
  if (order.length !== definitions.length) {
    throw new Error("Evaluator dependency topological sort incomplete");
  }
  topoOrder = order;
  dagValidated = true;
  return order;
}

export function getTopologicalEvaluatorOrder(): string[] {
  if (!dagValidated || !topoOrder) {
    return validateRegistryDag();
  }
  return topoOrder;
}

export function dependenciesOf(
  definition: EvaluatorDefinition,
): EvaluatorDependency[] {
  return definition.dependencies;
}

export function isEvaluatorApplicable(params: {
  definition: EvaluatorDefinition;
  subjectType: string;
  phase: string | null;
}): boolean {
  const { definition } = params;
  if (!definition.applicableSubjectTypes.includes(params.subjectType as never)) {
    return false;
  }
  if (definition.applicablePhases == null) return true;
  if (params.phase == null) return false;
  return definition.applicablePhases.includes(params.phase as never);
}
