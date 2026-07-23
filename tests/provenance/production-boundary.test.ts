import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  PRODUCTION_LAUNCH_SURFACES,
  PRODUCTION_SEND_SURFACES,
  launchSurfacesManifestDigest,
  sendSurfacesManifestDigest,
} from "../../src/provenance/launch-surfaces.js";
import {
  PRODUCTION_LAUNCH_MAPPING,
  allMappedLaunchSurfaces,
  resolveProductionLaunchSurface,
  validActionsForLaunchPhase,
  type ProductionLaunchAction,
  type ProductionLaunchPhase,
} from "../../src/provenance/production-launch-mapping.js";
import { InMemoryProvenanceEventStore } from "../../src/provenance/store.js";

const ROOT = path.resolve(".");
const PHASE_DIR = path.join(ROOT, "src/runner/phases");
const PRODUCTION_TS = path.join(ROOT, "src/agents/production.ts");
const PROVIDER_TS = path.join(ROOT, "src/agents/linear-harness-provider.ts");

const PRODUCTION_PHASE_FILES = [
  "planning.ts",
  "plan-review.ts",
  "implementation.ts",
  "code-review.ts",
  "code-revision.ts",
  "revision.ts",
  "integration-repair.ts",
] as const;

const EVAL_RUN_FILES = [
  "src/evaluation/native-skill-canary/run.ts",
  "src/evaluation/cursor-sdk-usage-probe/run.ts",
  "src/evaluation/langfuse-projection-canary/run.ts",
  "src/evaluation/langfuse-reproject/run.ts",
  "src/evaluation/langfuse-inspect/run.ts",
  "src/evaluation/cursor-usage-import/run.ts",
  "src/evaluation/cursor-usage-import-canary/run.ts",
] as const;

const DIRECT_LAUNCH_FN_TO_SURFACE: Record<string, string> = {
  createPlanningAgent: "planning.create",
  createPlanReviewAgent: "plan_review.create",
  resumePlanReviewAgent: "plan_review.resume",
  createCodeReviewAgent: "code_review.create",
  createCodeRevisionAgent: "code_revision.create",
};

const PRODUCTION_EXPORT_LAUNCH_FNS = new Set([
  ...Object.keys(DIRECT_LAUNCH_FN_TO_SURFACE),
  "acquireBuilderAgent",
]);

function parseTsFile(filePath: string): ts.SourceFile {
  const text = readFileSync(filePath, "utf8");
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visitNodes(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visitNodes(child, visitor));
}

function productionImportBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (!mod.text.endsWith("agents/production.js")) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      bindings.set(clause.name.text, clause.name.text);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        bindings.set(el.name.text, imported);
      }
    }
  }
  return bindings;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function literalString(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function literalNumber(node: ts.Expression | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return null;
}

function objectStringProperty(
  obj: ts.ObjectLiteralExpression,
  keyName: string,
): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name;
    const name = ts.isIdentifier(key)
      ? key.text
      : ts.isStringLiteral(key)
        ? key.text
        : null;
    if (name !== keyName) continue;
    return literalString(prop.initializer);
  }
  return null;
}

function isCallFromProductionImport(
  call: ts.CallExpression,
  productionBindings: Map<string, string>,
  importedName: string,
): boolean {
  const name = calleeName(call.expression);
  if (!name) return false;
  return productionBindings.get(name) === importedName;
}

function discoverSendSurfacesInPhaseFile(
  sourceFile: ts.SourceFile,
  productionBindings: Map<string, string>,
): Set<string> {
  const surfaces = new Set<string>();
  visitNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!isCallFromProductionImport(node, productionBindings, "sendAndObserve")) {
      return;
    }
    const options = node.arguments[4];
    if (!options || !ts.isObjectLiteralExpression(options)) return;
    const sendSurface = objectStringProperty(options, "sendSurface");
    if (sendSurface) surfaces.add(sendSurface);
  });
  return surfaces;
}

function discoverLaunchSurfacesInPhaseFile(
  sourceFile: ts.SourceFile,
  productionBindings: Map<string, string>,
): Set<string> {
  const surfaces = new Set<string>();

  visitNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;

    for (const [fn, surface] of Object.entries(DIRECT_LAUNCH_FN_TO_SURFACE)) {
      if (isCallFromProductionImport(node, productionBindings, fn)) {
        surfaces.add(surface);
      }
    }

    if (!isCallFromProductionImport(node, productionBindings, "acquireBuilderAgent")) {
      return;
    }
    const arg = node.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    const phase = objectStringProperty(arg, "phase") as ProductionLaunchPhase | null;
    if (!phase) return;
    for (const action of validActionsForLaunchPhase(phase)) {
      surfaces.add(resolveProductionLaunchSurface(phase, action));
    }
  });

  return surfaces;
}

function discoverProductionExportLaunchFns(sourceFile: ts.SourceFile): Set<string> {
  const exports = new Set<string>();
  visitNodes(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name) return;
    const mods = ts.getModifiers(node);
    const isExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExport) return;
    if (PRODUCTION_EXPORT_LAUNCH_FNS.has(node.name.text)) {
      exports.add(node.name.text);
    }
  });
  return exports;
}

function discoverForbiddenImports(sourceFile: ts.SourceFile): string[] {
  const hits: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (
      mod.text.includes("linear-harness-provider") ||
      mod.text.endsWith("agents/production.js")
    ) {
      hits.push(mod.text);
    }
  }
  return hits;
}

function sorted<T>(values: Iterable<T>): T[] {
  return [...values].sort();
}

describe("production provenance boundary", () => {
  it("launch mapping covers every canonical surface exactly once", () => {
    expect(allMappedLaunchSurfaces()).toEqual([...PRODUCTION_LAUNCH_SURFACES].sort());
    expect(PRODUCTION_LAUNCH_MAPPING).toHaveLength(PRODUCTION_LAUNCH_SURFACES.length);
    expect(launchSurfacesManifestDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves every valid phase/action and rejects invalid combos", () => {
    for (const row of PRODUCTION_LAUNCH_MAPPING) {
      expect(resolveProductionLaunchSurface(row.phase, row.action)).toBe(row.surface);
    }

    const invalid: Array<[ProductionLaunchPhase, ProductionLaunchAction]> = [
      ["planning", "resume"],
      ["planning", "replacement"],
      ["plan_review", "replacement"],
      ["revision", "create"],
      ["code_review", "resume"],
      ["code_review", "replacement"],
      ["code_revision", "resume"],
      ["code_revision", "replacement"],
      ["integration_repair", "create"],
    ];
    for (const [phase, action] of invalid) {
      expect(() => resolveProductionLaunchSurface(phase, action)).toThrow(
        /Invalid production launch mapping/,
      );
    }
  });

  it("send surfaces match AST-discovered sendAndObserve call sites", () => {
    const discovered = new Set<string>();
    for (const file of PRODUCTION_PHASE_FILES) {
      const sourceFile = parseTsFile(path.join(PHASE_DIR, file));
      const bindings = productionImportBindings(sourceFile);
      expect(bindings.size).toBeGreaterThan(0);
      for (const surface of discoverSendSurfacesInPhaseFile(sourceFile, bindings)) {
        discovered.add(surface);
      }
    }
    expect(sorted(discovered)).toEqual([...PRODUCTION_SEND_SURFACES].sort());
    expect(sendSurfacesManifestDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("launch surfaces match AST discovery via mapping and production exports", () => {
    const fromPhases = new Set<string>();
    for (const file of PRODUCTION_PHASE_FILES) {
      const sourceFile = parseTsFile(path.join(PHASE_DIR, file));
      const bindings = productionImportBindings(sourceFile);
      for (const surface of discoverLaunchSurfacesInPhaseFile(sourceFile, bindings)) {
        fromPhases.add(surface);
      }
    }

    const productionSf = parseTsFile(PRODUCTION_TS);
    const productionExports = discoverProductionExportLaunchFns(productionSf);
    expect(sorted(productionExports)).toEqual(
      sorted(PRODUCTION_EXPORT_LAUNCH_FNS),
    );

    expect(sorted(fromPhases)).toEqual([...PRODUCTION_LAUNCH_SURFACES].sort());
  });

  it("production phase modules import launch/send entrypoints from agents/production", () => {
    for (const file of PRODUCTION_PHASE_FILES) {
      const sourceFile = parseTsFile(path.join(PHASE_DIR, file));
      const bindings = productionImportBindings(sourceFile);
      expect(bindings.size).toBeGreaterThan(0);

      visitNodes(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        const name = calleeName(node.expression);
        if (!name) return;
        if (
          name === "sendAndObserve" ||
          name in DIRECT_LAUNCH_FN_TO_SURFACE ||
          name === "acquireBuilderAgent"
        ) {
          expect(bindings.has(name)).toBe(true);
        }
      });

      for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const mod = stmt.moduleSpecifier;
        if (!ts.isStringLiteral(mod)) continue;
        expect(mod.text).not.toMatch(/agents\/(index|cursor-provider)\.js$/);
        expect(mod.text).not.toContain("agent-factory");
      }
    }
  });

  it("sendAndObserve call sites declare literal sendSurface and sendOrdinal", () => {
    for (const file of PRODUCTION_PHASE_FILES) {
      const sourceFile = parseTsFile(path.join(PHASE_DIR, file));
      const bindings = productionImportBindings(sourceFile);
      visitNodes(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        if (!isCallFromProductionImport(node, bindings, "sendAndObserve")) return;
        const options = node.arguments[4];
        expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
        if (!options || !ts.isObjectLiteralExpression(options)) return;
        expect(objectStringProperty(options, "sendSurface")).toBeTruthy();
        expect(literalNumber(
          options.properties
            .filter(ts.isPropertyAssignment)
            .find((p) => {
              const key = p.name;
              return (
                (ts.isIdentifier(key) && key.text === "sendOrdinal") ||
                (ts.isStringLiteral(key) && key.text === "sendOrdinal")
              );
            })?.initializer,
        )).not.toBeNull();
      });
    }
  });

  it("production wrapper send path includes run intent and call-start hooks", () => {
    const provider = parseTsFile(PROVIDER_TS);
    let hasRunIntent = false;
    let hasRunCall = false;
    let hasInnerSend = false;
    visitNodes(provider, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calleeName(node.expression);
      if (name === "writeProviderRunIntent") hasRunIntent = true;
      if (name === "writeProviderRunCallStarted") hasRunCall = true;
      if (name === "sendAndObserve" && ts.isPropertyAccessExpression(node.expression)) {
        hasInnerSend = true;
      }
    });
    expect(hasRunIntent).toBe(true);
    expect(hasRunCall).toBe(true);
    expect(hasInnerSend).toBe(true);
  });

  it("evaluation run entrypoints do not import harness provider or production wrapper", () => {
    for (const rel of EVAL_RUN_FILES) {
      const sourceFile = parseTsFile(path.join(ROOT, rel));
      expect(discoverForbiddenImports(sourceFile)).toEqual([]);
    }
  });

  it("in-memory store starts empty (no live state writes)", () => {
    const store = new InMemoryProvenanceEventStore();
    expect(store.listEvents()).toEqual([]);
  });

  it("phase directory still contains only known production launch files", () => {
    const files = readdirSync(PHASE_DIR).filter((f) => f.endsWith(".ts"));
    for (const required of PRODUCTION_PHASE_FILES) {
      expect(files).toContain(required);
    }
  });

  it("new production phase mutation files must be included in structural scan", () => {
    const mutationFiles = readdirSync(PHASE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => {
        const sourceFile = parseTsFile(path.join(PHASE_DIR, f));
        const bindings = productionImportBindings(sourceFile);
        const launches = discoverLaunchSurfacesInPhaseFile(sourceFile, bindings);
        const sends = discoverSendSurfacesInPhaseFile(sourceFile, bindings);
        return launches.size > 0 || sends.size > 0;
      })
      .sort();
    for (const file of mutationFiles) {
      expect(PRODUCTION_PHASE_FILES).toContain(file);
    }
  });
});
