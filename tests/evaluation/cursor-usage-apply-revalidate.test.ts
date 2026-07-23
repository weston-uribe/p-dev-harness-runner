import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCsvImport,
  preflightCsvImport,
} from "../../src/evaluation/cursor-usage-import/service.js";
import type { UsageCandidate } from "../../src/evaluation/cursor-usage-import/discovery.js";
import {
  MULTI_MODEL_EXECUTION_PROVEN_FIELD,
} from "../../src/evaluation/cursor-usage-import/types.js";
import {
  normalizeModelRaw,
  resolveCanonicalModelId,
} from "../../src/evaluation/cursor-usage-import/model-aliases.js";
import { hashCloudAgentId } from "../../src/evaluation/cursor-usage-import/parse.js";
import type { EvaluationRuntimeConfig } from "../../src/evaluation/types.js";
import type { LangfuseApiClient } from "../../src/evaluation/langfuse-inspect/client.js";
import {
  makeReadyDiscoveryConfig,
  readyDiscoveryResolver,
} from "./helpers/cursor-usage-discovery-test.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cursor-usage",
);
const sampleCsv = readFileSync(path.join(fixtureDir, "sample-usage.csv"), "utf8");

const exportWindow = {
  startIso: "2026-07-19T00:00:00.000Z",
  endIso: "2026-07-20T00:00:00.000Z",
  timezone: "UTC",
  precision: "millisecond" as const,
  boundsSource: "cli_flags" as const,
};

const langfuseConfig: EvaluationRuntimeConfig = {
  provider: "langfuse",
  captureProfile: "metadata-v1",
  publicKey: "pk",
  secretKey: "sk",
  baseUrl: "http://example.invalid",
  namespace: "default",
  tracingEnvironment: "test",
  release: null,
};

function makeCandidate(params: {
  agentId: string;
  phase: "planning" | "plan_review";
  traceId: string;
  windowStart: string;
  windowEnd: string;
}): UsageCandidate {
  const observedModels = [
    {
      rawModel: "composer-2.5",
      normalizedRawModel: normalizeModelRaw("composer-2.5"),
      canonicalModelId: resolveCanonicalModelId("composer-2.5"),
      variant: "standard" as const,
      observationIds: [`obs-${params.traceId}`],
    },
  ];
  return {
    traceId: params.traceId,
    sessionId: "a".repeat(64),
    timestamp: params.windowStart,
    cursorAgentId: params.agentId,
    cursorAgentIdHash: hashCloudAgentId(params.agentId),
    issueKey: "TT-FIXTURE",
    phase: params.phase,
    phaseExecutionId: `pe-${params.phase}`,
    harnessRunId: `hr-${params.phase}`,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    model: "composer-2.5",
    effectiveVariant: "standard",
    existingCursorScoreNames: [],
    observedModels,
    observedModelIds: ["composer-2.5"],
    multiModelExecutionProven: false,
    multiModelProofField: MULTI_MODEL_EXECUTION_PROVEN_FIELD,
  };
}

const readyDiscoverCandidates = [
  makeCandidate({
    agentId: "bc-agent-planning-001",
    phase: "planning",
    traceId: "trace-planning",
    windowStart: "2026-07-19T11:00:00.000Z",
    windowEnd: "2026-07-19T13:00:00.000Z",
  }),
  makeCandidate({
    agentId: "bc-agent-planreview-001",
    phase: "plan_review",
    traceId: "trace-plan-review",
    windowStart: "2026-07-19T12:00:00.000Z",
    windowEnd: "2026-07-19T14:00:00.000Z",
  }),
];

const discoveryConfig = makeReadyDiscoveryConfig({
  namespace: "default",
  environmentFilter: null,
  baseUrl: "http://127.0.0.1:18999",
});

const serviceDeps = {
  createApiClient: async () => ({}) as LangfuseApiClient,
  resolveDiscoveryConfig: readyDiscoveryResolver(discoveryConfig),
};

describe("cursor usage apply revalidation", () => {
  it("throws on apply when discover returns empty and never calls score client", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    let scoreClientCalls = 0;

    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      logDirectory,
      langfuseConfig,
      discoverLangfuse: true,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.lifecycle).toBe("ready");

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          discover: async () => ({
            candidates: [],
            retrievalComplete: false,
          }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toThrow(
      /preflight_plan_changed|source_scope_incomplete|retrieval was incomplete|langfuse_retrieval_incomplete/,
    );

    expect(scoreClientCalls).toBe(0);
  });

  it("throws on apply when discover retrieval is incomplete and never calls score client", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    let scoreClientCalls = 0;

    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      logDirectory,
      langfuseConfig,
      discoverLangfuse: true,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          discover: async () => ({
            candidates: readyDiscoverCandidates,
            retrievalComplete: false,
          }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toThrow(
      /preflight_plan_changed|source_scope_incomplete:langfuse_retrieval_incomplete|langfuse_retrieval_incomplete|Langfuse discovery retrieval was incomplete/,
    );

    expect(scoreClientCalls).toBe(0);
  });

  it("throws import_lifecycle_not_applicable after preflighted lifecycle", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      logDirectory,
      discoverLangfuse: false,
    });
    expect(preflight.lifecycle).toBe("preflighted");

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        langfuseConfig,
        deps: serviceDeps,
      }),
    ).rejects.toThrow("import_lifecycle_not_applicable:preflighted");
  });

  it("throws import_fingerprint_mismatch for wrong fingerprint", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      logDirectory,
      discoverLangfuse: false,
    });

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: "wrong-fingerprint-value",
        confirmed: true,
        logDirectory,
        namespace: "default",
        langfuseConfig,
        deps: serviceDeps,
      }),
    ).rejects.toThrow("import_fingerprint_mismatch");
  });

  it("fails closed when second segment rate changes while first is unchanged", async () => {
    const { computeCostProxies } = await import(
      "../../src/evaluation/cursor-usage-import/proxy-cost.js"
    );
    const pricedCsv = [
      "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
      "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,100,0,50,150,Included",
      "2026-07-19T13:00:00.000Z,bc-agent-planreview-001,,Included,composer-2.5,false,0,80,0,40,120,Included",
    ].join("\n");
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    let scoreClientCalls = 0;
    const preflight = await preflightCsvImport({
      csvBytes: pricedCsv,
      exportWindow,
      namespace: "default",
      environment: "test",
      logDirectory,
      langfuseConfig,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.sourceScopeComplete).toBe(true);

    let call = 0;
    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        environment: "test",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          discover: async () => ({
            candidates: readyDiscoverCandidates,
            retrievalComplete: true,
          }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
          computeCostProxies: (params) => {
            const base = computeCostProxies(params);
            if (!base) return null;
            call += 1;
            // Leave the first segment unchanged; mutate the second segment only.
            if (call === 1) return base;
            return {
              ...base,
              knownNoncacheCostUsd: base.knownNoncacheCostUsd + 0.5,
              pricingManifest: {
                ...base.pricingManifest,
                inputUsdPer1M: "123.45",
                matchedObservedVariant: "fast",
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/preflight_plan_changed/);

    expect(scoreClientCalls).toBe(0);
  });

  it("blocks recovery write when existing score comment is not retrievable", async () => {
    const { validateExistingScoresAgainstManifest } = await import(
      "../../src/evaluation/cursor-usage-import/service.js"
    );
    const { digestCanonical } = await import(
      "../../src/evaluation/cursor-usage-import/expected-score-manifest.js"
    );
    const staged = {
      scoreId: "score-1",
      targetTraceId: "trace-a",
      scoreName: "cursor_total_tokens",
      dataType: "NUMERIC",
      canonicalValueSerialization: "10",
      scoreTimestamp: "2026-07-19T12:00:00.000Z",
      environment: "test",
      scoreClass: "cursor_usage_import",
      commentProvenanceFingerprint: digestCanonical("comment-a"),
      publicSafeMetadataDigest: digestCanonical({}),
      sourceBundleFingerprint: "fp",
      issueKey: "TT-1",
      phase: "planning",
      scoreContractVersion: "10.0.0",
      pricingManifest: null,
    };
    const errors = validateExistingScoresAgainstManifest({
      stagedScores: [staged],
      existingMapped: [
        {
          id: "score-1",
          name: "cursor_total_tokens",
          traceId: "trace-a",
          value: 10,
          dataType: "NUMERIC",
          timestamp: "2026-07-19T12:00:00.000Z",
          // comment omitted → fail closed
        },
      ],
    });
    expect(errors[0]).toMatch(/existing_score_comment_not_retrievable/);
  });

  it("blocks recovery when existing score name/timestamp/comment fingerprint mismatch", async () => {
    const { validateExistingScoresAgainstManifest } = await import(
      "../../src/evaluation/cursor-usage-import/service.js"
    );
    const { digestCanonical } = await import(
      "../../src/evaluation/cursor-usage-import/expected-score-manifest.js"
    );
    const staged = {
      scoreId: "score-1",
      targetTraceId: "trace-a",
      scoreName: "cursor_total_tokens",
      dataType: "NUMERIC",
      canonicalValueSerialization: "10",
      scoreTimestamp: "2026-07-19T12:00:00.000Z",
      environment: "test",
      scoreClass: "cursor_usage_import",
      commentProvenanceFingerprint: digestCanonical("expected-comment"),
      publicSafeMetadataDigest: digestCanonical({}),
      sourceBundleFingerprint: "fp",
      issueKey: "TT-1",
      phase: "planning",
      scoreContractVersion: "10.0.0",
      pricingManifest: null,
    };
    expect(
      validateExistingScoresAgainstManifest({
        stagedScores: [staged],
        existingMapped: [
          {
            id: "score-1",
            name: "cursor_input_tokens",
            traceId: "trace-a",
            value: 10,
            dataType: "NUMERIC",
            timestamp: "2026-07-19T12:00:00.000Z",
            comment: "expected-comment",
          },
        ],
      })[0],
    ).toMatch(/existing_score_name_mismatch/);

    expect(
      validateExistingScoresAgainstManifest({
        stagedScores: [staged],
        existingMapped: [
          {
            id: "score-1",
            name: "cursor_total_tokens",
            traceId: "trace-b",
            value: 10,
            dataType: "NUMERIC",
            timestamp: "2026-07-19T12:00:00.000Z",
            comment: "expected-comment",
          },
        ],
      })[0],
    ).toMatch(/existing_score_trace_mismatch/);

    expect(
      validateExistingScoresAgainstManifest({
        stagedScores: [staged],
        existingMapped: [
          {
            id: "score-1",
            name: "cursor_total_tokens",
            traceId: "trace-a",
            value: 10,
            dataType: "BOOLEAN",
            timestamp: "2026-07-19T12:00:00.000Z",
            comment: "expected-comment",
          },
        ],
      })[0],
    ).toMatch(/existing_score_data_type_mismatch/);

    expect(
      validateExistingScoresAgainstManifest({
        stagedScores: [staged],
        existingMapped: [
          {
            id: "score-1",
            name: "cursor_total_tokens",
            traceId: "trace-a",
            value: 10,
            dataType: "NUMERIC",
            timestamp: "2026-07-19T13:00:00.000Z",
            comment: "expected-comment",
          },
        ],
      })[0],
    ).toMatch(/existing_score_timestamp_mismatch/);

    expect(
      validateExistingScoresAgainstManifest({
        stagedScores: [staged],
        existingMapped: [
          {
            id: "score-1",
            name: "cursor_total_tokens",
            traceId: "trace-a",
            value: 10,
            dataType: "NUMERIC",
            timestamp: "2026-07-19T12:00:00.000Z",
            comment: "wrong-comment",
          },
        ],
      })[0],
    ).toMatch(/existing_score_comment_mismatch/);
  });

  it("fails closed with zero writes when pricing rates change under same registry version", async () => {
    const { computeCostProxies } = await import(
      "../../src/evaluation/cursor-usage-import/proxy-cost.js"
    );
    // Zero cache buckets so list-rate pricing is complete and numeric cost scores emit.
    const pricedCsv = [
      "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
      "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,100,0,50,150,Included",
      "2026-07-19T13:00:00.000Z,bc-agent-planreview-001,,Included,composer-2.5,false,0,80,0,40,120,Included",
    ].join("\n");
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    let scoreClientCalls = 0;
    const preflight = await preflightCsvImport({
      csvBytes: pricedCsv,
      exportWindow,
      namespace: "default",
      environment: "test",
      logDirectory,
      langfuseConfig,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.sourceScopeComplete).toBe(true);

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        environment: "test",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          discover: async () => ({
            candidates: readyDiscoverCandidates,
            retrievalComplete: true,
          }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
          computeCostProxies: (params) => {
            const base = computeCostProxies(params);
            if (!base) return null;
            return {
              ...base,
              knownNoncacheCostUsd: base.knownNoncacheCostUsd + 1.23,
              allInputAtListRateUsd: base.allInputAtListRateUsd + 1.23,
              pricingManifest: {
                ...base.pricingManifest,
                inputUsdPer1M: "999.99",
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/preflight_plan_changed/);

    expect(scoreClientCalls).toBe(0);
  });

  it("rejects legacy v10 staged imports before creating a score client", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-v10-"));
    let scoreClientCalls = 0;
    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      environment: "test",
      logDirectory,
      langfuseConfig,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.sourceScopeComplete).toBe(true);

    const stagingRoot = path.join(
      logDirectory,
      "evaluation-reports/cursor-usage-imports",
      preflight.importId,
    );
    const preflightPath = path.join(stagingRoot, "preflight.private.json");
    const evidencePath = path.join(stagingRoot, "parser-evidence.private.json");
    const preflightJson = JSON.parse(readFileSync(preflightPath, "utf8")) as {
      importerVersion: string;
      schemaVersion: number;
    };
    const evidenceJson = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      schemaVersion: number;
    };
    preflightJson.importerVersion = "10.0.0";
    preflightJson.schemaVersion = 1;
    evidenceJson.schemaVersion = 1;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(preflightPath, `${JSON.stringify(preflightJson, null, 2)}\n`);
    writeFileSync(evidencePath, `${JSON.stringify(evidenceJson, null, 2)}\n`);

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        environment: "test",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toThrow("staged_import_version_mismatch_requires_new_preflight");
    expect(scoreClientCalls).toBe(0);
  });

  it("fails closed when blank-ID capability classification changes before apply", async () => {
    const mixedCsv = [
      "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
      "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,100,0,50,150,Included",
      "2026-07-19T12:30:00.000Z,,,Included,composer-2.5,false,0,20,0,5,25,Included",
      "2026-07-19T13:00:00.000Z,bc-agent-planreview-001,,Included,composer-2.5,false,0,80,0,40,120,Included",
    ].join("\n");
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-cap-"));
    let scoreClientCalls = 0;
    const preflight = await preflightCsvImport({
      csvBytes: mixedCsv,
      exportWindow,
      namespace: "default",
      environment: "test",
      logDirectory,
      langfuseConfig,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.publicSummary.nonCloudAgentExcludedRowCount).toBe(1);

    const evidencePath = path.join(
      logDirectory,
      "evaluation-reports/cursor-usage-imports",
      preflight.importId,
      "parser-evidence.private.json",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      rows: Array<{ agentCellBlank: boolean; rowCapability: string }>;
    };
    const blank = evidence.rows.find((r) => r.agentCellBlank);
    expect(blank).toBeTruthy();
    blank!.rowCapability = "cloud_agent_attributable";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        environment: "test",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toThrow(/preflight_plan_changed/);
    expect(scoreClientCalls).toBe(0);
  });

  it("fails closed on discovery config drift (namespace / env / host / project scope)", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-apply-"));
    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      logDirectory,
      langfuseConfig,
      discoverLangfuse: true,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.sourceScopeComplete).toBe(true);

    const cases = [
      makeReadyDiscoveryConfig({
        namespace: "other-ns",
        environmentFilter: null,
      }),
      makeReadyDiscoveryConfig({
        namespace: "default",
        environmentFilter: "dogfood",
      }),
      makeReadyDiscoveryConfig({
        namespace: "default",
        environmentFilter: "default",
      }),
      makeReadyDiscoveryConfig({
        namespace: "default",
        environmentFilter: null,
        baseUrl: "http://127.0.0.1:19000",
      }),
      makeReadyDiscoveryConfig({
        namespace: "default",
        environmentFilter: null,
        publicKey: "pk-other-project",
      }),
    ];

    for (const drifted of cases) {
      let scoreClientCalls = 0;
      await expect(
        applyCsvImport({
          importId: preflight.importId,
          fingerprint: preflight.fingerprint,
          preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
          confirmed: true,
          logDirectory,
          namespace: "default",
          langfuseConfig,
          deps: {
            createApiClient: async () => ({}) as LangfuseApiClient,
            resolveDiscoveryConfig: readyDiscoveryResolver(drifted),
            discover: async () => ({
              candidates: readyDiscoverCandidates,
              retrievalComplete: true,
            }),
            createScoreClient: async () => {
              scoreClientCalls += 1;
              return { recordScore() {}, flush: async () => {} };
            },
          },
        }),
      ).rejects.toThrow("discovery_configuration_changed_requires_new_preflight");
      expect(scoreClientCalls).toBe(0);
    }

    // Secret rotation keeps the same project-scope digest (covered in discovery-config tests).
    const rotated = makeReadyDiscoveryConfig({
      namespace: "default",
      environmentFilter: null,
      secretKey: "sk-rotated",
    });
    expect(rotated.langfuseProjectScopeDigest).toBe(
      discoveryConfig.langfuseProjectScopeDigest,
    );
  });

  it("fails Apply on 13.0.0 deterministic evidence drift before score client", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cursor-usage-1300-"));
    let scoreClientCalls = 0;
    const preflight = await preflightCsvImport({
      csvBytes: sampleCsv,
      exportWindow,
      namespace: "default",
      environment: "test",
      logDirectory,
      langfuseConfig,
      deps: {
        ...serviceDeps,
        discover: async () => ({
          candidates: readyDiscoverCandidates,
          retrievalComplete: true,
        }),
      },
    });
    expect(preflight.sourceScopeComplete).toBe(true);

    const stagingRoot = path.join(
      logDirectory,
      "evaluation-reports/cursor-usage-imports",
      preflight.importId,
    );
    const preflightPath = path.join(stagingRoot, "preflight.private.json");
    const preflightJson = JSON.parse(readFileSync(preflightPath, "utf8")) as {
      importerVersion: string;
      deterministicDiscoveryEvidenceDigest?: string;
    };
    preflightJson.importerVersion = "13.0.0";
    // Simulate IO-era tracesDigest drift vs core,scores-only rediscovery.
    preflightJson.deterministicDiscoveryEvidenceDigest = "stale-io-era-digest";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(preflightPath, `${JSON.stringify(preflightJson, null, 2)}\n`);

    await expect(
      applyCsvImport({
        importId: preflight.importId,
        fingerprint: preflight.fingerprint,
        preflightApprovalFingerprint: preflight.preflightApprovalFingerprint,
        confirmed: true,
        logDirectory,
        namespace: "default",
        environment: "test",
        langfuseConfig,
        deps: {
          ...serviceDeps,
          discover: async () => ({
            candidates: readyDiscoverCandidates,
            retrievalComplete: true,
          }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toThrow("preflight_plan_changed:discovery_evidence");
    expect(scoreClientCalls).toBe(0);
  });
});
