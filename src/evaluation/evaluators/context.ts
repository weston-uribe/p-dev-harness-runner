import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getAgentTelemetryPath,
  getGithubPrPath,
  getManifestPath,
  getPrMetadataPath,
  getRunDirectory,
  getTelemetryCompletenessPath,
} from "../../artifacts/paths.js";
import type { RunManifest } from "../../types/run.js";
import type { EvaluationSubject } from "../subjects/types.js";
import type { AgentTelemetryEvent, ArtifactRef } from "../telemetry/types.js";
import { resolveConfinedArtifactPath } from "./path-safety.js";
import type {
  EvaluationContext,
  EvaluatorDefinition,
  EvaluatorResult,
  ResolvedEvidenceItem,
} from "./types.js";

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function resolveArtifactEvidence(params: {
  key: string;
  required: boolean;
  optional: boolean;
  ref: ArtifactRef | null;
  roots: {
    logDirectory: string;
    issueKey: string;
    evaluationDirectory: string;
    runDirectory: string | null;
  };
  loadContent: boolean;
}): Promise<ResolvedEvidenceItem> {
  const base: ResolvedEvidenceItem = {
    key: params.key,
    present: false,
    required: params.required,
    optional: params.optional,
    path: null,
    sha256: null,
    absenceMarker: "absent",
    untrusted: false,
    untrustedReason: null,
    content: null,
  };
  if (!params.ref) return base;

  const safety = resolveConfinedArtifactPath(params.ref.artifactPath, params.roots);
  if (!safety.ok) {
    return {
      ...base,
      path: params.ref.artifactPath,
      sha256: params.ref.sha256,
      absenceMarker: null,
      untrusted: true,
      untrustedReason: safety.reason,
    };
  }

  try {
    const buf = await readFile(safety.absolutePath);
    const actualHash = sha256Buffer(buf);
    if (params.ref.sha256 && actualHash !== params.ref.sha256) {
      return {
        ...base,
        path: params.ref.artifactPath,
        sha256: params.ref.sha256,
        absenceMarker: null,
        untrusted: true,
        untrustedReason: "hash_mismatch",
      };
    }
    return {
      key: params.key,
      present: true,
      required: params.required,
      optional: params.optional,
      path: params.ref.artifactPath,
      sha256: actualHash,
      absenceMarker: null,
      untrusted: false,
      untrustedReason: null,
      content: params.loadContent ? buf.toString("utf8") : null,
    };
  } catch {
    return {
      ...base,
      path: params.ref.artifactPath,
      sha256: params.ref.sha256,
      absenceMarker: "absent",
    };
  }
}

function findSubjectRef(
  subject: EvaluationSubject,
  kinds: string[],
): ArtifactRef | null {
  for (const ref of subject.evidenceArtifactRefs ?? []) {
    if (kinds.includes(ref.artifactKind) || kinds.includes(ref.artifactPath)) {
      return ref;
    }
  }
  // Also match by path fragment keys used in extraction
  for (const ref of subject.evidenceArtifactRefs ?? []) {
    const p = ref.artifactPath;
    if (kinds.includes("prompt") && p.includes("/prompts/")) return ref;
    if (kinds.includes("agent_output") && p.includes("/outputs/")) return ref;
    if (kinds.includes("pm_feedback") && p.includes("pm-feedback")) return ref;
    if (kinds.includes("cursor_run_result") && p.includes("run-result"))
      return ref;
    if (
      kinds.includes("pr_metadata") &&
      (p.includes("pr.json") || p.includes("pr-metadata"))
    )
      return ref;
  }
  return null;
}

export async function buildEvaluationContext(params: {
  subject: EvaluationSubject;
  sessionSubjects: EvaluationSubject[];
  definition: EvaluatorDefinition;
  logDirectory: string;
  issueKey: string;
  evaluationDirectory: string;
  dependencyResults: EvaluatorResult[];
  rubricDefinitionHash: string;
  evaluationPolicyVersion: string | null;
  evaluationPolicyHash: string | null;
  now?: () => string;
}): Promise<EvaluationContext> {
  const now = params.now ?? (() => new Date().toISOString());
  const runDirectory =
    params.subject.harnessRunId != null
      ? getRunDirectory(
          params.logDirectory,
          params.issueKey,
          params.subject.harnessRunId,
        )
      : null;

  const roots = {
    logDirectory: params.logDirectory,
    issueKey: params.issueKey,
    evaluationDirectory: params.evaluationDirectory,
    runDirectory,
  };

  const manifestsByRunId: Record<string, RunManifest> = {};
  for (const s of params.sessionSubjects) {
    if (!s.harnessRunId) continue;
    const rd = getRunDirectory(
      params.logDirectory,
      params.issueKey,
      s.harnessRunId,
    );
    const manifest = await readJsonIfExists<RunManifest>(getManifestPath(rd));
    if (manifest) manifestsByRunId[s.harnessRunId] = manifest;
  }

  const manifest =
    runDirectory != null
      ? await readJsonIfExists<RunManifest>(getManifestPath(runDirectory))
      : null;

  let telemetryEvents: AgentTelemetryEvent[] = [];
  let telemetryPresent = false;
  let telemetryUntrusted = false;
  let telemetryUntrustedReason: string | null = null;
  let telemetryPath: string | null = null;
  let telemetryHash: string | null = null;
  if (runDirectory) {
    const telPath = getAgentTelemetryPath(runDirectory);
    telemetryPath = path.relative(runDirectory, telPath).split(path.sep).join("/");
    const safety = resolveConfinedArtifactPath(telemetryPath, roots);
    if (!safety.ok) {
      telemetryUntrusted = true;
      telemetryUntrustedReason = safety.reason;
    } else {
      const text = await readTextIfExists(safety.absolutePath);
      if (text != null) {
        telemetryPresent = true;
        telemetryHash = sha256Buffer(Buffer.from(text, "utf8"));
        telemetryEvents = text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as AgentTelemetryEvent);
      }
    }
  }

  let telemetryCompleteness: unknown | null = null;
  let completenessPresent = false;
  let completenessPath: string | null = null;
  let completenessHash: string | null = null;
  let completenessUntrusted = false;
  let completenessUntrustedReason: string | null = null;
  if (runDirectory) {
    const cPath = getTelemetryCompletenessPath(runDirectory);
    completenessPath = path
      .relative(runDirectory, cPath)
      .split(path.sep)
      .join("/");
    const safety = resolveConfinedArtifactPath(completenessPath, roots);
    if (!safety.ok) {
      completenessUntrusted = true;
      completenessUntrustedReason = safety.reason;
    } else {
      const raw = await readTextIfExists(safety.absolutePath);
      if (raw != null) {
        completenessPresent = true;
        completenessHash = sha256Buffer(Buffer.from(raw, "utf8"));
        try {
          telemetryCompleteness = JSON.parse(raw);
        } catch {
          completenessUntrusted = true;
          completenessUntrustedReason = "completeness_unparseable";
        }
      }
    }
  }

  const evidence: Record<string, ResolvedEvidenceItem> = {};
  const keys = new Set([
    ...params.definition.requiredEvidence,
    ...params.definition.optionalEvidence,
  ]);

  for (const key of keys) {
    const required = params.definition.requiredEvidence.includes(key);
    const optional = params.definition.optionalEvidence.includes(key);

    if (key === "manifest") {
      evidence.manifest = {
        key: "manifest",
        present: manifest != null,
        required,
        optional,
        path: runDirectory ? "manifest.json" : null,
        sha256: null,
        absenceMarker: manifest != null ? null : "absent",
        untrusted: false,
        untrustedReason: null,
        content: manifest != null ? JSON.stringify(manifest) : null,
      };
      continue;
    }
    if (key === "manifests") {
      evidence.manifests = {
        key: "manifests",
        present: Object.keys(manifestsByRunId).length > 0,
        required,
        optional,
        path: null,
        sha256: null,
        absenceMarker:
          Object.keys(manifestsByRunId).length > 0 ? null : "absent",
        untrusted: false,
        untrustedReason: null,
        content: null,
      };
      continue;
    }
    if (key === "session_subjects") {
      evidence.session_subjects = {
        key: "session_subjects",
        present: params.sessionSubjects.length > 0,
        required,
        optional,
        path: "subjects.jsonl",
        sha256: null,
        absenceMarker: params.sessionSubjects.length > 0 ? null : "absent",
        untrusted: false,
        untrustedReason: null,
        content: null,
      };
      continue;
    }
    if (key === "telemetry") {
      evidence.telemetry = {
        key: "telemetry",
        present: telemetryPresent,
        required,
        optional,
        path: telemetryPath,
        sha256: telemetryHash,
        absenceMarker: telemetryPresent ? null : "absent",
        untrusted: telemetryUntrusted,
        untrustedReason: telemetryUntrustedReason,
        content: null,
      };
      continue;
    }
    if (key === "telemetry_completeness") {
      evidence.telemetry_completeness = {
        key: "telemetry_completeness",
        present: completenessPresent,
        required,
        optional,
        path: completenessPath,
        sha256: completenessHash,
        absenceMarker: completenessPresent ? null : "absent",
        untrusted: completenessUntrusted,
        untrustedReason: completenessUntrustedReason,
        content: null,
      };
      continue;
    }
    if (key === "deployment") {
      const hasDeploy = Object.values(manifestsByRunId).some(
        (m) => Boolean(m.deploymentUrl) || Boolean(m.previewUrl),
      );
      evidence.deployment = {
        key: "deployment",
        present: hasDeploy,
        required,
        optional,
        path: null,
        sha256: null,
        absenceMarker: hasDeploy ? null : "absent",
        untrusted: false,
        untrustedReason: null,
        content: null,
      };
      continue;
    }

    let ref = findSubjectRef(params.subject, [key]);
    // Fallback known paths for PR metadata
    if (!ref && key === "pr_metadata" && runDirectory) {
      const candidates = [getGithubPrPath(runDirectory), getPrMetadataPath(runDirectory)];
      for (const abs of candidates) {
        const rel = path.relative(runDirectory, abs).split(path.sep).join("/");
        const text = await readTextIfExists(abs);
        if (text != null) {
          ref = {
            artifactKind: "other",
            artifactPath: rel,
            sha256: sha256Buffer(Buffer.from(text, "utf8")),
            byteCount: Buffer.byteLength(text, "utf8"),
            redactionStatus: "none",
          };
          break;
        }
      }
    }

    evidence[key] = await resolveArtifactEvidence({
      key,
      required,
      optional,
      ref,
      roots,
      loadContent: true,
    });
  }

  // Include optional-affects-behavior absences already covered by optionalEvidence loop.

  return {
    subject: params.subject,
    sessionSubjects: params.sessionSubjects,
    logDirectory: params.logDirectory,
    issueKey: params.issueKey,
    evaluationDirectory: params.evaluationDirectory,
    runDirectory,
    manifest,
    manifestsByRunId,
    telemetryEvents,
    telemetryCompleteness,
    evidence,
    dependencyResults: params.dependencyResults,
    rubricDefinitionHash: params.rubricDefinitionHash,
    evaluatorImplementationHash: params.definition.implementationHash,
    evaluationPolicyVersion: params.evaluationPolicyVersion,
    evaluationPolicyHash: params.evaluationPolicyHash,
    now,
  };
}

export function evidenceItemsForFingerprint(
  definition: EvaluatorDefinition,
  evidence: Record<string, ResolvedEvidenceItem>,
): ResolvedEvidenceItem[] {
  const keys = new Set([
    ...definition.requiredEvidence,
    ...definition.optionalEvidence,
  ]);
  const affects = new Set(definition.optionalEvidenceAffectsBehavior ?? []);
  const items: ResolvedEvidenceItem[] = [];
  for (const key of keys) {
    const item = evidence[key];
    if (!item) continue;
    if (item.optional && !item.present && !affects.has(key)) {
      // Optional absence that cannot affect behavior — still include when listed
      // in optionalEvidenceAffectsBehavior only; plan says include optional absence
      // when absence can affect behavior.
      continue;
    }
    items.push(item);
  }
  // Always include all required keys (present or absent)
  for (const key of definition.requiredEvidence) {
    if (!items.some((i) => i.key === key) && evidence[key]) {
      items.push(evidence[key]);
    }
  }
  // Include optional that affect behavior even when absent
  for (const key of affects) {
    if (!items.some((i) => i.key === key) && evidence[key]) {
      items.push(evidence[key]);
    }
  }
  return items;
}
