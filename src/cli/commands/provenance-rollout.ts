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

    console.error(
      "Unknown action. Use: readiness | quiet-window | activate | inspect-coverage | finalize | enumerate-seal-to-tip | generate-key | install-key | set-mode | shred-local-key-dir",
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
