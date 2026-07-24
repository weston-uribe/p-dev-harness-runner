import {
  createRestrictedKeyTempDir,
  generateProvenanceKey,
  installProvenanceKeySecret,
  inspectProvenanceRolloutReadiness,
  publicSafeRolloutEvidence,
  readKeyMaterialFromStdinOrFile,
  setProvenanceMode,
  shredRestrictedKeyArtifacts,
  validateGeneratedKey,
  writeRestrictedKeyFile,
} from "../../provenance/rollout.js";
import type { ProvenanceWriterMode } from "../../provenance/mode.js";
import {
  canaryCreateOrAdopt,
  canaryTrigger,
  canaryValidate,
} from "../../provenance/canary-issue.js";
import { observeProvenanceCanary } from "../../provenance/canary-observe.js";
import {
  decideKeyRecoverability,
  ensureKeyRecoverability,
  enumerateProvenanceHistory,
  inspectLocalRecoveryStore,
} from "../../provenance/key-recoverability.js";
import {
  activateEpoch,
  createOperatorCoverageContext,
  enumeratePostSeal,
  finalizeEpoch,
  inspectEpoch,
} from "../../provenance/operator-coverage.js";
import {
  DEFAULT_QUIET_WINDOW_POLL_GAP_MS,
  waitAndInspectQuietWindow,
  type QuietWindowObservation,
} from "../../provenance/quiet-window.js";
import {
  resolveStateGithubToken,
  resolveWorkflowStateBranch,
  resolveWorkflowStateRepository,
} from "../../public-execution/runtime-repos.js";
import { GitHubClient } from "../../github/client.js";

async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runProvenanceRolloutCommand(options: {
  action: string;
  configPath?: string;
  issue?: string;
  canaryOperationId?: string;
  replacementFor?: string;
  mode?: string;
  keyFile?: string;
  runnerRepo?: string;
  shadowValidated?: boolean;
  json?: boolean;
  epochId?: string;
  coverageStart?: string;
  coverageEnd?: string;
  captureSourceSha?: string;
  runnerSha?: string;
  eventSnapshotSha?: string;
  operatorToolSourceSha?: string;
  priorObservationJson?: string;
  pollGapSeconds?: number;
}): Promise<number> {
  const action = options.action.trim().toLowerCase();

  try {
    if (action === "readiness" || action === "inspect") {
      const readiness = await inspectProvenanceRolloutReadiness({
        runnerRepository: options.runnerRepo,
      });
      const evidence = publicSafeRolloutEvidence({ readiness });
      if (options.json) {
        console.log(JSON.stringify(evidence, null, 2));
      } else {
        console.log(
          `mode=${evidence.mode} healthy=${evidence.healthy} writer=${evidence.writerVersion} secretConfigured=${evidence.secretConfigured}`,
        );
        for (const check of readiness.checks) {
          console.log(`  [${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}`);
        }
      }
      return readiness.failClosedReason && readiness.mode !== "disabled" ? 1 : 0;
    }

    if (action === "quiet-window") {
      const token =
        resolveStateGithubToken() ??
        process.env.GITHUB_TOKEN?.trim() ??
        process.env.GH_TOKEN?.trim();
      if (!token) {
        throw new Error("GitHub token required for quiet-window inspection.");
      }
      const stateRepo = resolveWorkflowStateRepository();
      const pollGapMs =
        typeof options.pollGapSeconds === "number" &&
        Number.isFinite(options.pollGapSeconds)
          ? Math.max(0, Math.floor(options.pollGapSeconds * 1000))
          : DEFAULT_QUIET_WINDOW_POLL_GAP_MS;

      // Optional single-sample resume path when operator supplies prior observation.
      if (options.priorObservationJson?.trim()) {
        const { inspectQuietWindow } = await import(
          "../../provenance/quiet-window.js"
        );
        const priorObservation = JSON.parse(
          options.priorObservationJson,
        ) as QuietWindowObservation;
        const result = await inspectQuietWindow({
          client: new GitHubClient({ token }),
          runnerRepository: options.runnerRepo,
          stateRepository: stateRepo ?? undefined,
          stateBranch: resolveWorkflowStateBranch(),
          priorObservation,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `quiet=${result.quiet} activeRuns=${result.activeRuns.length} tipSha=${result.tipSha ?? "unknown"}`,
          );
          if (result.failClosedReason) {
            console.log(`failClosedReason=${result.failClosedReason}`);
          }
        }
        return result.quiet ? 0 : 1;
      }

      if (!options.json) {
        console.log(
          `quiet-window: sampling twice with pollGapMs=${pollGapMs} (covers two reconcile cycles by default)`,
        );
      }
      const result = await waitAndInspectQuietWindow({
        client: new GitHubClient({ token }),
        runnerRepository: options.runnerRepo,
        stateRepository: stateRepo ?? undefined,
        stateBranch: resolveWorkflowStateBranch(),
        pollGapMs,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `quiet=${result.quiet} activeRuns=${result.activeRuns.length} tipSha=${result.tipSha ?? "unknown"}`,
        );
        if (result.failClosedReason) {
          console.log(`failClosedReason=${result.failClosedReason}`);
        }
        for (const run of result.activeRuns) {
          console.log(`  run ${run.id} ${run.status} ${run.name} (${run.event})`);
        }
      }
      return result.quiet ? 0 : 1;
    }

    if (action === "activate") {
      if (
        !options.epochId ||
        !options.coverageStart ||
        !options.coverageEnd ||
        !options.captureSourceSha ||
        !options.runnerSha
      ) {
        throw new Error(
          "activate requires --epoch-id, --coverage-start, --coverage-end, --capture-source-sha, --runner-sha",
        );
      }
      const ctx = createOperatorCoverageContext();
      const result = await activateEpoch(ctx, {
        epochId: options.epochId,
        coverageStart: options.coverageStart,
        coverageEnd: options.coverageEnd,
        captureProducerSourceSha: options.captureSourceSha,
        productionRunnerSha: options.runnerSha,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `epoch=${result.epochId} activationCommitSha=${result.activationCommitSha ?? "unknown"} payloadDigestPrefix=${result.payloadDigestPrefix}`,
        );
      }
      return 0;
    }

    if (action === "inspect-coverage") {
      if (!options.epochId) {
        throw new Error("inspect-coverage requires --epoch-id");
      }
      const ctx = createOperatorCoverageContext();
      const result = await inspectEpoch(ctx, {
        epochId: options.epochId,
        eventSnapshotCommitSha: options.eventSnapshotSha,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `epoch=${result.epochId} status=${result.status} events=${result.eventCount} incomplete=${result.incompleteReasons.length}`,
        );
      }
      return result.status === "complete" ? 0 : 1;
    }

    if (action === "finalize") {
      if (!options.epochId || !options.operatorToolSourceSha) {
        throw new Error(
          "finalize requires --epoch-id and --operator-tool-source-sha",
        );
      }
      const ctx = createOperatorCoverageContext();
      const result = await finalizeEpoch(ctx, {
        epochId: options.epochId,
        eventSnapshotCommitSha: options.eventSnapshotSha,
        operatorToolSourceSha: options.operatorToolSourceSha,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.sealed) {
        console.log(
          `sealed epoch=${result.epochId} sealCommitSha=${result.sealCommitSha ?? "unknown"} sealDigestPrefix=${result.sealDigestPrefix}`,
        );
      } else {
        console.log(
          `gap epoch=${result.epochId} gapCommitSha=${result.gapCommitSha ?? "unknown"} reasons=${result.incompleteReasons.join(",")}`,
        );
      }
      return result.sealed ? 0 : 1;
    }

    if (action === "enumerate-seal-to-tip") {
      if (!options.epochId) {
        throw new Error("enumerate-seal-to-tip requires --epoch-id");
      }
      const ctx = createOperatorCoverageContext();
      const result = await enumeratePostSeal(ctx, {
        epochId: options.epochId,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `seal=${result.sealCommitSha} tip=${result.tipCommitSha} items=${result.items.length} overlappingRaw=${result.overlappingRawEvidenceCount}`,
        );
      }
      return 0;
    }

    if (action === "generate-key") {
      const prevUmask = process.umask(0o077);
      const dir = createRestrictedKeyTempDir();
      try {
        const key = generateProvenanceKey();
        validateGeneratedKey(key);
        const path = writeRestrictedKeyFile(dir, key);
        if (options.json) {
          console.log(
            JSON.stringify({
              keyId: "provenance-key-v1",
              keyFile: path,
              keyMaterialPrinted: false,
            }),
          );
        } else {
          console.log(`Wrote restricted key file (mode 0600): ${path}`);
          console.log("Install with: provenance install-key --key-file <path>");
          console.log("Key material is not printed.");
        }
        return 0;
      } finally {
        process.umask(prevUmask);
      }
    }

    if (action === "install-key") {
      const stdinData = await readStdinIfPiped();
      const keyMaterial = readKeyMaterialFromStdinOrFile({
        filePath: options.keyFile,
        stdinData,
      });
      const result = await installProvenanceKeySecret({
        keyMaterial,
        runnerRepository: options.runnerRepo,
      });
      if (options.json) {
        console.log(
          JSON.stringify({
            installed: result.installed,
            keyId: result.keyId,
            keyMaterialPrinted: false,
            keyValueReadBack: false,
          }),
        );
      } else {
        console.log(`Installed ${result.keyId} (value never echoed or read back).`);
      }
      return 0;
    }

    if (action === "set-mode") {
      const mode = (options.mode ?? "").trim().toLowerCase() as ProvenanceWriterMode;
      if (mode !== "disabled" && mode !== "shadow" && mode !== "required") {
        console.error("mode must be disabled|shadow|required");
        return 1;
      }
      const result = await setProvenanceMode({
        mode,
        runnerRepository: options.runnerRepo,
        shadowValidated: options.shadowValidated === true,
      });
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`mode ${result.previous ?? "(unset)"} -> ${result.next}`);
      }
      return 0;
    }

    if (action === "shred-local-key-dir") {
      if (!options.keyFile) {
        console.error("--key-file parent directory required for shred");
        return 1;
      }
      const dir = options.keyFile.replace(/\/[^/]+$/, "");
      shredRestrictedKeyArtifacts(dir);
      console.log("Local key artifacts shredded.");
      return 0;
    }

    if (action === "canary-create") {
      const apiKey = process.env.LINEAR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for canary-create.");
      }
      const result = await canaryCreateOrAdopt({
        linearApiKey: apiKey,
        operationId: options.canaryOperationId,
        replacementForIssueKey: options.replacementFor,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `canary issue=${result.issueKey} adopted=${result.adopted} op=${result.operationId}`,
        );
        console.log(`evidenceFile=${result.evidenceFile}`);
      }
      return 0;
    }

    if (action === "canary-validate") {
      const apiKey = process.env.LINEAR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for canary-validate.");
      }
      const issueKey = options.issue?.trim();
      if (!issueKey) {
        throw new Error("--issue is required for canary-validate.");
      }
      const configPath = options.configPath?.trim() || "harness.config.json";
      const { events, inspection } = await enumerateProvenanceHistory();
      const priorCount = events.filter((event) => {
        if (event.eventType === "launch_intent") {
          return event.launchContext.linearIssueKey === issueKey;
        }
        if (event.eventType === "provider_run_bound") {
          return event.linearIssueKey === issueKey;
        }
        return false;
      }).length;

      const result = await canaryValidate({
        configPath,
        linearApiKey: apiKey,
        issueKey,
        priorProvenanceEventCount: priorCount,
      });
      const output = {
        ...result,
        provenanceTipCommitPrefix: inspection.tipCommitSha
          ? inspection.tipCommitSha.slice(0, 12)
          : null,
        priorProvenanceEventCount: priorCount,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(
          `ok=${result.ok} issue=${result.issueKey} status=${result.statusName ?? "unknown"} priorEvents=${priorCount}`,
        );
        if (!result.ok) {
          console.log(`failClosedReason=${result.failClosedReason ?? "unknown"}`);
        }
      }
      return result.ok ? 0 : 1;
    }

    if (action === "canary-trigger") {
      const apiKey = process.env.LINEAR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for canary-trigger.");
      }
      const issueKey = options.issue?.trim();
      if (!issueKey) {
        throw new Error("--issue is required for canary-trigger.");
      }
      const configPath = options.configPath?.trim() || "harness.config.json";
      const { events } = await enumerateProvenanceHistory();
      const priorCount = events.filter((event) => {
        if (event.eventType === "launch_intent") {
          return event.launchContext.linearIssueKey === issueKey;
        }
        if (event.eventType === "provider_run_bound") {
          return event.linearIssueKey === issueKey;
        }
        return false;
      }).length;

      const result = await canaryTrigger({
        configPath,
        linearApiKey: apiKey,
        issueKey,
        priorProvenanceEventCount: priorCount,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `ok=${result.ok} transitioned=${result.transitioned} issue=${result.issueKey} ${result.fromStatus ?? "?"} -> ${result.toStatus}`,
        );
        if (!result.ok) {
          console.log(`failClosedReason=${result.failClosedReason ?? "unknown"}`);
        }
      }
      return result.ok ? 0 : 1;
    }

    if (action === "canary-observe") {
      const apiKey = process.env.LINEAR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for canary-observe.");
      }
      const issueKey = options.issue?.trim();
      if (!issueKey) {
        throw new Error("--issue is required for canary-observe.");
      }
      const result = await observeProvenanceCanary({
        issueKey,
        linearApiKey: apiKey,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `ok=${result.ok} issue=${result.issue.key} status=${result.issue.status ?? "unknown"} attempts=${result.provenance.matchingAttempts} tip=${result.provenance.tipCommitPrefix ?? "unknown"}`,
        );
        if (result.committedEnvelopeValidation.attempted) {
          console.log(
            `envelopes ok=${result.committedEnvelopeValidation.summary.ok} count=${result.committedEnvelopeValidation.summary.envelopeCount}`,
          );
        } else {
          console.log(
            `envelopes attempted=false reason=${result.committedEnvelopeValidation.reason}`,
          );
        }
      }
      return result.ok ? 0 : 1;
    }

    if (action === "key-recoverability") {
      const { inspection: history } = await enumerateProvenanceHistory();
      const local = inspectLocalRecoveryStore();
      const decision = await decideKeyRecoverability({ history, local });
      const output = {
        ok: decision.kind === "recoverable",
        decision: decision.kind,
        local,
        history,
        replacementMarkerPath: decision.replacementMarkerPath,
        keyMaterialPrinted: false,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(
          `decision=${decision.kind} localPresent=${local.present} valid=${local.validFormat} envelopes=${history.envelopeCount}`,
        );
      }
      return decision.kind === "recoverable" ? 0 : 1;
    }

    if (action === "ensure-key") {
      const result = await ensureKeyRecoverability({
        runnerRepository: options.runnerRepo ?? "weston-uribe/p-dev-harness-runner",
        pollGapSeconds: options.pollGapSeconds,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `ok=${result.ok} kind=${result.kind} localPresent=${result.local.present} valid=${result.local.validFormat} envelopes=${result.history.envelopeCount}`,
        );
        if (result.failClosedReason) {
          console.log(`failClosedReason=${result.failClosedReason}`);
        }
      }
      return result.ok ? 0 : 1;
    }

    console.error(
      "Unknown action. Use: readiness | quiet-window | activate | inspect-coverage | finalize | enumerate-seal-to-tip | generate-key | install-key | set-mode | shred-local-key-dir | canary-create | canary-validate | canary-trigger | canary-observe | key-recoverability | ensure-key",
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    return 1;
  }
}
