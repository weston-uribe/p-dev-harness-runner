import { NextRequest, NextResponse } from "next/server";
import {
  CURSOR_USAGE_UPLOAD_MAX_BYTES,
  guardCursorUsageMultipartUpload,
  guardCursorUsageOperatorRequest,
} from "@/lib/cursor-usage-request-guard";
import {
  buildExportWindow,
  prepareAsyncPreflightStart,
  resolveCursorUsageServerContext,
  runPreflightCsvImport,
  workspaceIdentityFromLogDirectory,
} from "@/lib/cursor-usage-server";
import { CursorUsageDiscoveryError } from "@harness/evaluation/cursor-usage-import/discovery-config.js";
import {
  attachPreflightWork,
  beginPreflightCommit,
  completePreflightFailure,
  completePreflightSuccess,
  createPreflightOperation,
  getPreflightOperation,
  markPreflightRunning,
  requestPreflightCancel,
  takePreflightCsvBytes,
  toPublicStatus,
  updatePreflightProgress,
} from "@harness/evaluation/cursor-usage-import/preflight-operation-registry.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function mapPreflightError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (error instanceof CursorUsageDiscoveryError) {
    return {
      code: error.code,
      message: error.message,
      status: error.httpStatus,
    };
  }
  const message =
    error instanceof Error ? error.message : "Preflight import failed.";
  if (
    message === "inspection_digest_mismatch" ||
    message === "inspection_token_mismatch" ||
    message === "export_window_unproven" ||
    message === "invalid_assumed_timezone" ||
    message.startsWith("Missing required CSV column")
  ) {
    return { code: message, message, status: 400 };
  }
  return { code: "preflight_failed", message, status: 500 };
}

function resultPayload(result: Awaited<ReturnType<typeof runPreflightCsvImport>>) {
  return {
    importId: result.importId,
    fingerprint: result.fingerprint,
    preflightApprovalFingerprint: result.preflightApprovalFingerprint,
    lifecycle: result.lifecycle,
    sourceScopeComplete: result.sourceScopeComplete,
    sourceScopeIncompleteReason:
      result.publicSummary.sourceScopeIncompleteReason ?? null,
    bundleCount: result.bundleCount,
    publicSummary: result.publicSummary,
    rows: result.rows,
    conflicts: result.conflicts,
    discoveryDiagnostics: result.discoveryDiagnostics,
    uploadScopedRejectionCount: result.publicSummary.uploadScopedRejectionCount,
    agentScopedRejectionCount: result.publicSummary.agentScopedRejectionCount,
    rejectionReasonCodes: result.publicSummary.rejectionReasonCodes,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageOperatorRequest(request);
  if (!guard.ok) return guard.response;

  const operationId = request.nextUrl.searchParams.get("operationId")?.trim();
  if (!operationId) {
    return NextResponse.json(
      {
        error: "operationId is required.",
        code: "cursor_usage_preflight_operation_not_found",
      },
      { status: 404 },
    );
  }

  const ctx = await resolveCursorUsageServerContext();
  const workspaceIdentity = workspaceIdentityFromLogDirectory(ctx.logDirectory);
  const op = getPreflightOperation(operationId, workspaceIdentity);
  if (!op) {
    return NextResponse.json(
      {
        error: "Preflight operation not found.",
        code: "cursor_usage_preflight_operation_not_found",
      },
      { status: 404 },
    );
  }
  return NextResponse.json(toPublicStatus(op));
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageOperatorRequest(request);
  if (!guard.ok) return guard.response;

  const operationId = request.nextUrl.searchParams.get("operationId")?.trim();
  if (!operationId) {
    return NextResponse.json(
      {
        error: "operationId is required.",
        code: "cursor_usage_preflight_operation_not_found",
      },
      { status: 404 },
    );
  }

  const ctx = await resolveCursorUsageServerContext();
  const workspaceIdentity = workspaceIdentityFromLogDirectory(ctx.logDirectory);
  const result = requestPreflightCancel(operationId, workspaceIdentity);
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.code === "cursor_usage_preflight_cancel_too_late"
            ? "Preflight cancel arrived too late; staging commit already started."
            : "Preflight operation not found.",
        code: result.code,
      },
      {
        status:
          result.code === "cursor_usage_preflight_cancel_too_late" ? 409 : 404,
      },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      /** Acknowledgement only — terminal cancelled is published after settlement. */
      code: "langfuse_discovery_cancelled",
      cancelRequested: !result.alreadyTerminal,
      alreadyTerminal: result.alreadyTerminal,
    },
    { status: 200 },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageMultipartUpload(request);
  if (!guard.ok) {
    return guard.response;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form.", code: "invalid_multipart" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const boundsSource = String(formData.get("boundsSource") ?? "csv_row_extrema").trim();
  const exportStart = String(formData.get("exportStart") ?? "").trim();
  const exportEnd = String(formData.get("exportEnd") ?? "").trim();
  const exportTimezone = String(formData.get("timezone") ?? "UTC").trim();
  const assumedTimezone = String(formData.get("assumedTimezone") ?? "").trim();
  const disambiguation = String(formData.get("disambiguation") ?? "").trim();
  const expectedSourceDigestSha256 = String(
    formData.get("expectedSourceDigestSha256") ?? "",
  ).trim();
  const expectedInspectionToken = String(
    formData.get("expectedInspectionToken") ?? "",
  ).trim();
  const advancedOverride =
    String(formData.get("advancedOverride") ?? "") === "true";

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "CSV file is required.", code: "csv_required" },
      { status: 400 },
    );
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return NextResponse.json(
      { error: "CSV filename required.", code: "csv_filename_required" },
      { status: 400 },
    );
  }
  if (file.size > CURSOR_USAGE_UPLOAD_MAX_BYTES) {
    return NextResponse.json(
      { error: "Payload too large.", code: "payload_too_large" },
      { status: 413 },
    );
  }

  const useManual =
    advancedOverride && boundsSource === "operator_gui_fields";
  if (useManual && (!exportStart || !exportEnd)) {
    return NextResponse.json(
      {
        error: "Export window start and end are required for manual override.",
        code: "export_window_required",
      },
      { status: 400 },
    );
  }

  const csvBytes = Buffer.from(await file.arrayBuffer());
  const exportWindow = useManual
    ? buildExportWindow({
        exportStart,
        exportEnd,
        exportTimezone,
      })
    : {
        startIso: "",
        endIso: "",
        timezone: "UTC",
        precision: "millisecond" as const,
        boundsSource: "csv_row_extrema" as const,
      };
  const disambiguationPolicy =
    disambiguation === "earlier" || disambiguation === "later"
      ? disambiguation
      : ("reject_ambiguous" as const);

  let prepared: Awaited<ReturnType<typeof prepareAsyncPreflightStart>>;
  try {
    prepared = await prepareAsyncPreflightStart({
      csvBytes,
      exportWindow,
      assumedTimezone: assumedTimezone || null,
      disambiguationPolicy,
      expectedSourceDigestSha256: expectedSourceDigestSha256 || null,
      expectedInspectionToken: expectedInspectionToken || null,
    });
  } catch (error) {
    const mapped = mapPreflightError(error);
    return NextResponse.json(
      { error: mapped.message, code: mapped.code },
      { status: mapped.status },
    );
  }

  const { operationId, controller } = createPreflightOperation({
    workspaceIdentity: prepared.workspaceIdentity,
    csvBytes,
  });

  const work = (async () => {
    markPreflightRunning(operationId);
    const bytes = takePreflightCsvBytes(operationId);
    if (!bytes) {
      await prepared.discoveryLock.release();
      completePreflightFailure(
        operationId,
        "preflight_failed",
        "CSV bytes were released before discovery started.",
      );
      return;
    }
    try {
      const result = await runPreflightCsvImport({
        csvBytes: bytes,
        exportWindow: prepared.exportWindow,
        assumedTimezone: assumedTimezone || null,
        disambiguationPolicy,
        expectedSourceDigestSha256: expectedSourceDigestSha256 || null,
        expectedInspectionToken: expectedInspectionToken || null,
        signal: controller.signal,
        workspaceIdentity: prepared.workspaceIdentity,
        skipDiscoveryLock: true,
        beforeStagingCommit: () => beginPreflightCommit(operationId),
        onProgress: (p) => {
          const patch: Parameters<typeof updatePreflightProgress>[1] = {
            tracesFetched: p.traces,
          };
          if (
            p.phase === "trace_retrieval" ||
            p.phase === "observation_retrieval" ||
            p.phase === "candidate_construction"
          ) {
            patch.phase = p.phase;
          }
          if (p.phase === "trace_retrieval") {
            patch.tracePagesFetched = p.pages;
          }
          if (p.phase === "observation_retrieval") {
            patch.observationPagesFetched = p.pages;
          }
          if (typeof p.observations === "number") {
            patch.observationsFetched = p.observations;
          }
          if (typeof p.targetObservationsRetained === "number") {
            patch.targetObservationsRetained = p.targetObservationsRetained;
          }
          updatePreflightProgress(operationId, patch);
        },
      });
      completePreflightSuccess(operationId, resultPayload(result));
    } catch (error) {
      const mapped = mapPreflightError(error);
      completePreflightFailure(operationId, mapped.code, mapped.message);
    } finally {
      await prepared.discoveryLock.release();
    }
  })();
  attachPreflightWork(operationId, work);

  return NextResponse.json(
    {
      operationId,
      state: "queued",
      phase: "source_inspection",
    },
    { status: 202 },
  );
}
