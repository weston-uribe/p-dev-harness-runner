"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cancelCursorUsagePreflight,
  clearStoredPreflightOperationId,
  fetchCursorUsageAnalytics,
  fetchCursorUsageConfig,
  fetchCursorUsagePreflightStatus,
  fetchCursorUsageStatus,
  getStoredPreflightOperationId,
  postCursorUsageApply,
  postCursorUsageInspect,
  postCursorUsagePreflight,
  storePreflightOperationId,
  type AnalyticsResponse,
  type CursorUsageConfigResponse,
  type CursorUsageInspectResponse,
  type ImportStatusResponse,
  type PreflightOperationStatus,
  type PreflightResponse,
} from "@/lib/cursor-usage-client";
import { UploadPanel } from "./UploadPanel";
import { ExportWindowFields } from "./ExportWindowFields";
import { SourceSummaryPanel } from "./SourceSummaryPanel";
import { PreflightTable } from "./PreflightTable";
import { ApplyConfirm } from "./ApplyConfirm";
import { ResultsPanel } from "./ResultsPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { DiscoveryConfigPanel } from "./DiscoveryConfigPanel";
import { ProvenanceCoveragePanel } from "./ProvenanceCoveragePanel";

interface CursorUsagePageProps {
  nonce: string | null;
}

export function CursorUsagePage({ nonce }: CursorUsagePageProps) {
  const [config, setConfig] = useState<CursorUsageConfigResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<CursorUsageInspectResponse | null>(
    null,
  );
  const [exportStart, setExportStart] = useState("");
  const [exportEnd, setExportEnd] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [advancedOverride, setAdvancedOverride] = useState(false);
  const [assumedTimezone, setAssumedTimezone] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [status, setStatus] = useState<ImportStatusResponse | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opStatus, setOpStatus] = useState<PreflightOperationStatus | null>(
    null,
  );

  const refreshAnalytics = useCallback(async () => {
    try {
      const next = await fetchCursorUsageAnalytics();
      setAnalytics(next);
    } catch {
      // analytics are supplementary
    }
  }, []);

  useEffect(() => {
    void fetchCursorUsageConfig()
      .then(setConfig)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not load configuration.",
        );
      });
    void refreshAnalytics();
  }, [refreshAnalytics]);

  const recoverStatus = useCallback(async (importId: string) => {
    try {
      const next = await fetchCursorUsageStatus(importId);
      if (next) {
        setStatus(next);
      }
    } catch {
      // ignore recovery errors
    }
  }, []);

  useEffect(() => {
    const stored = window.sessionStorage.getItem("cursor-usage-import-id");
    if (stored) {
      void recoverStatus(stored);
    }
  }, [recoverStatus]);

  // Resume in-flight async preflight across refresh (process-local registry).
  useEffect(() => {
    if (!nonce) return;
    const operationId = getStoredPreflightOperationId();
    if (!operationId) return;
    let cancelled = false;
    setBusy(true);
    const poll = async () => {
      while (!cancelled) {
        try {
          const next = await fetchCursorUsagePreflightStatus(operationId, nonce);
          if (cancelled) return;
          setOpStatus(next);
          if (next.state === "succeeded" && next.result) {
            clearStoredPreflightOperationId();
            setPreflight(next.result);
            window.sessionStorage.setItem(
              "cursor-usage-import-id",
              next.result.importId,
            );
            const importStatus = await fetchCursorUsageStatus(
              next.result.importId,
            );
            setStatus(importStatus);
            setBusy(false);
            return;
          }
          if (next.state === "failed" || next.state === "cancelled") {
            clearStoredPreflightOperationId();
            setError(next.errorMessage ?? "Preflight failed.");
            setBusy(false);
            return;
          }
        } catch (err) {
          clearStoredPreflightOperationId();
          setError(
            err instanceof Error ? err.message : "Preflight status unavailable.",
          );
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 750));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const runInspect = useCallback(
    async (nextFile: File) => {
      if (!nonce) {
        setError("Security token unavailable. Reload the page.");
        return;
      }
      setInspecting(true);
      setError(null);
      setPreflight(null);
      try {
        const formData = new FormData();
        formData.set("file", nextFile);
        if (assumedTimezone.trim()) {
          formData.set("assumedTimezone", assumedTimezone.trim());
        }
        const result = await postCursorUsageInspect(formData, nonce);
        setInspection(result);
        if (result.observedWindow) {
          setExportStart(result.observedWindow.startIso);
          setExportEnd(result.observedWindow.endIso);
          setTimezone(result.observedWindow.timezone);
        } else if (result.minTimestampIso && result.maxTimestampIso) {
          setExportStart(result.minTimestampIso);
          setExportEnd(result.maxTimestampIso);
        }
        if (result.timezoneEvidence === "UTC") {
          setTimezone("UTC");
        }
      } catch (err) {
        setInspection(null);
        setError(err instanceof Error ? err.message : "Inspection failed.");
      } finally {
        setInspecting(false);
      }
    },
    [assumedTimezone, nonce],
  );

  const onFileSelected = (next: File | null) => {
    setFile(next);
    setInspection(null);
    setPreflight(null);
    setConfirmed(false);
    setOpStatus(null);
    if (!advancedOverride) {
      setExportStart("");
      setExportEnd("");
      setTimezone("UTC");
    }
    if (next) {
      void runInspect(next);
    }
  };

  const runPreflight = async () => {
    if (!nonce) {
      setError("Security token unavailable. Reload the page.");
      return;
    }
    if (!file) {
      setError("Select a CSV file first.");
      return;
    }
    if (!inspection) {
      setError("Wait for source inspection to finish.");
      return;
    }
    if (advancedOverride && (!exportStart || !exportEnd)) {
      setError("Manual override requires start and end.");
      return;
    }
    setBusy(true);
    setError(null);
    setConfirmed(false);
    setPreflight(null);
    setOpStatus(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set(
        "boundsSource",
        advancedOverride ? "operator_gui_fields" : "csv_row_extrema",
      );
      formData.set("advancedOverride", advancedOverride ? "true" : "false");
      formData.set("exportStart", exportStart);
      formData.set("exportEnd", exportEnd);
      formData.set("timezone", timezone);
      formData.set(
        "expectedSourceDigestSha256",
        inspection.sourceDigestSha256,
      );
      formData.set("expectedInspectionToken", inspection.inspectionToken);
      if (assumedTimezone.trim()) {
        formData.set("assumedTimezone", assumedTimezone.trim());
      }
      const result = await postCursorUsagePreflight(formData, nonce, {
        onStatus: (next) => {
          setOpStatus(next);
          if (next.operationId) storePreflightOperationId(next.operationId);
        },
      });
      setPreflight(result);
      window.sessionStorage.setItem("cursor-usage-import-id", result.importId);
      const nextStatus = await fetchCursorUsageStatus(result.importId);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight failed.");
    } finally {
      setBusy(false);
    }
  };

  const cancelPreflight = async () => {
    if (!nonce || !opStatus?.operationId || opStatus.cancelRequested) return;
    try {
      await cancelCursorUsagePreflight(opStatus.operationId, nonce);
      // Keep polling until terminal cancelled — do not claim completion yet.
      setOpStatus((prev) =>
        prev
          ? {
              ...prev,
              cancelRequested: true,
              errorCode: "langfuse_discovery_cancelled",
              errorMessage: "Langfuse discovery was cancelled.",
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed.");
    }
  };

  const runApply = async () => {
    if (!nonce || !preflight || applying) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await postCursorUsageApply(
        {
          importId: preflight.importId,
          fingerprint: preflight.fingerprint,
          preflightApprovalFingerprint:
            preflight.preflightApprovalFingerprint ?? preflight.fingerprint,
          confirmed: true,
        },
        nonce,
      );
      const nextStatus = await fetchCursorUsageStatus(preflight.importId);
      setStatus(nextStatus);
      await refreshAnalytics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  };

  const windowReady =
    advancedOverride
      ? exportStart.trim().length > 0 && exportEnd.trim().length > 0
      : Boolean(inspection?.observedWindow);
  const hasConflicts = (preflight?.conflicts.length ?? 0) > 0;
  const alreadyVerified = status?.verified === true;
  const configReady = config?.configurationStatus === "ready";
  const preflightActive =
    busy &&
    opStatus != null &&
    (opStatus.state === "queued" ||
      opStatus.state === "running" ||
      opStatus.state === "committing");

  return (
    <div className="space-y-6" data-testid="cursor-usage-page">
      <div
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        data-testid="cursor-usage-langfuse-banner"
      >
        PDev Cloud Agent trace enrichment does not repair the historical native
        Langfuse generation cost dashboard. It only adds deterministic phase
        trace scores from attributable Cloud Agent CSV rows.
      </div>

      <DiscoveryConfigPanel config={config} />

      <ProvenanceCoveragePanel
        status={config?.provenanceCoverage ?? null}
      />

      <UploadPanel
        file={file}
        disabled={busy || applying || inspecting}
        onFileSelected={onFileSelected}
      />

      <SourceSummaryPanel inspection={inspection} />

      <ExportWindowFields
        exportStart={exportStart}
        exportEnd={exportEnd}
        timezone={timezone}
        timezoneEvidence={inspection?.timezoneEvidence ?? null}
        sortOrder={inspection?.sortOrder ?? null}
        advancedOverride={advancedOverride}
        assumedTimezone={assumedTimezone}
        disabled={busy || applying || inspecting}
        onExportStartChange={setExportStart}
        onExportEndChange={setExportEnd}
        onTimezoneChange={setTimezone}
        onAdvancedOverrideChange={setAdvancedOverride}
        onAssumedTimezoneChange={setAssumedTimezone}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={
            busy ||
            applying ||
            inspecting ||
            !configReady ||
            !file ||
            !inspection ||
            !windowReady
          }
          onClick={() => void runPreflight()}
          data-testid="cursor-usage-preflight-button"
        >
          {busy
            ? "Running preflight…"
            : inspecting
              ? "Inspecting…"
              : "Run preflight"}
        </button>
        {preflightActive && !opStatus?.cancelRequested ? (
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium disabled:opacity-50"
            disabled={opStatus?.state === "committing"}
            onClick={() => void cancelPreflight()}
            data-testid="cursor-usage-preflight-cancel"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {opStatus && busy ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="cursor-usage-preflight-progress"
        >
          {opStatus.cancelRequested && opStatus.state !== "cancelled"
            ? "Cancelling…"
            : (opStatus.phase ?? opStatus.state)}
          {" · "}
          {Math.round(opStatus.elapsedMs / 1000)}s
          {" · "}
          traces {opStatus.tracesFetched}
          {" · "}
          obs pages {opStatus.observationPagesFetched}
          {" · "}
          observations {opStatus.observationsFetched}
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {preflight ? (
        <>
          <PreflightTable
            rows={preflight.rows}
            sourceScopeComplete={preflight.sourceScopeComplete}
            sourceScopeIncompleteReason={preflight.sourceScopeIncompleteReason}
            uploadScopedRejectionCount={preflight.uploadScopedRejectionCount}
            agentScopedRejectionCount={preflight.agentScopedRejectionCount}
            rejectionReasonCodes={preflight.rejectionReasonCodes}
            conflicts={preflight.conflicts}
            discoveryDiagnostics={preflight.discoveryDiagnostics}
            bundleCount={preflight.bundleCount}
          />
          <ApplyConfirm
            confirmed={confirmed}
            disabled={
              applying ||
              alreadyVerified ||
              !preflight.sourceScopeComplete ||
              hasConflicts ||
              (preflight.uploadScopedRejectionCount ?? 0) > 0 ||
              preflight.bundleCount === 0
            }
            applying={applying}
            onConfirmedChange={setConfirmed}
            onApply={() => void runApply()}
          />
        </>
      ) : null}

      <ResultsPanel
        status={status}
        publicSummary={preflight?.publicSummary ?? null}
      />
      <AnalyticsPanel analytics={analytics} />
    </div>
  );
}
