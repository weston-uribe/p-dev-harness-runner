"use client";

import { useCallback, useMemo, useState } from "react";
import type { TargetWorkflowFinalizationResult } from "@harness/setup/target-workflow-finalization-types";
import type {
  RemoteTargetWorkflowApplyResult,
  RemoteTargetWorkflowPreview,
} from "@harness/setup/remote-actions";
import type { RemoteSetupRepoSummary } from "@harness/setup/remote-setup-summary";
import { FORM } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/custom/status-badge";
import { RemoteActionPreview } from "@/components/custom/remote-action-preview";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import { ReviewWorkflowChangesDisclosure } from "@/components/custom/review-workflow-changes-disclosure";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";

interface TargetWorkflowPrCardProps {
  repo: RemoteSetupRepoSummary;
  onApplied: () => void;
  onGuidedApplySuccess?: (
    result: RemoteTargetWorkflowApplyResult,
    finalization?: TargetWorkflowFinalizationResult,
  ) => void;
  blockedByUpstream?: boolean;
  variant?: "advanced" | "guided";
}

function accessVariant(
  status: RemoteSetupRepoSummary["repoAccess"],
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "available") return "success";
  if (status === "denied") return "destructive";
  return "secondary";
}

function workflowVariant(
  status: RemoteSetupRepoSummary["workflowStatus"],
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "present") return "success";
  if (
    status === "differs" ||
    status === "missing" ||
    status === "stale_dispatch_target" ||
    status === "contract_outdated"
  ) {
    return "warning";
  }
  return "secondary";
}

function workflowStatusLabel(
  status: RemoteSetupRepoSummary["workflowStatus"],
  variant: "advanced" | "guided",
): string {
  if (variant === "guided") {
    switch (status) {
      case "present":
        return "workflow ready";
      case "missing":
        return "workflow missing";
      case "differs":
        return "workflow outdated";
      case "stale_dispatch_target":
        return "stale dispatch target";
      case "contract_outdated":
        return "contract outdated";
      default:
        return "workflow status unknown";
    }
  }
  return status;
}

export function TargetWorkflowPrCard({
  repo,
  onApplied,
  onGuidedApplySuccess,
  blockedByUpstream = false,
  variant = "advanced",
}: TargetWorkflowPrCardProps) {
  const [preview, setPreview] = useState<RemoteTargetWorkflowPreview | null>(
    null,
  );
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<RemoteTargetWorkflowApplyResult | null>(null);

  const currentKey = `${repo.repoConfigId}:${repo.targetRepo}:${repo.productionBranch}`;
  const previewIsCurrent = preview !== null && previewKey === currentKey;

  const runPreview = useCallback(async (): Promise<RemoteTargetWorkflowPreview> => {
    const response = await fetch("/api/setup/preview-target-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoConfigId: repo.repoConfigId,
        targetRepo: repo.targetRepo,
        productionBranch: repo.productionBranch,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Preview failed");
    }
    const nextPreview = data as RemoteTargetWorkflowPreview;
    setPreview(nextPreview);
    setPreviewKey(currentKey);
    setPreviewError(null);
    return nextPreview;
  }, [currentKey, repo.productionBranch, repo.repoConfigId, repo.targetRepo]);

  const handlePreview = async () => {
    setLoading("preview");
    setError(null);
    setPreviewError(null);
    setApplyResult(null);
    setConfirmed(false);
    try {
      await runPreview();
    } catch (nextPreviewError) {
      setPreview(null);
      setPreviewKey(null);
      const message =
        nextPreviewError instanceof Error
          ? nextPreviewError.message
          : "Preview failed";
      setPreviewError(message);
      setError(message);
    } finally {
      setLoading(null);
    }
  };

  const handleDisclosureOpenChange = useCallback(
    (open: boolean) => {
      if (blockedByUpstream) {
        return;
      }
      setDisclosureOpen(open);
      if (open && !previewIsCurrent && loading !== "preview") {
        void handlePreview();
      }
    },
    [blockedByUpstream, loading, previewIsCurrent],
  );

  const handleApply = async () => {
    if (!confirmed) {
      return;
    }

    setLoading("apply");
    setError(null);
    try {
      const effectivePreview =
        previewIsCurrent && preview ? preview : await runPreview();
      if (effectivePreview.validationError) {
        throw new Error(effectivePreview.validationError);
      }

      const response = await fetch("/api/setup/apply-target-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoConfigId: repo.repoConfigId,
          targetRepo: repo.targetRepo,
          productionBranch: repo.productionBranch,
          confirmed: true,
          fingerprint: effectivePreview.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Apply failed");
      }
      const apply = data.apply as RemoteTargetWorkflowApplyResult;
      const finalization = data.finalization as
        | TargetWorkflowFinalizationResult
        | undefined;
      setPreview(null);
      setPreviewKey(null);
      setConfirmed(false);
      setDisclosureOpen(false);
      if (variant === "guided") {
        onGuidedApplySuccess?.(apply, finalization);
      } else {
        setApplyResult(apply);
      }
      onApplied();
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : "Apply failed",
      );
    } finally {
      setLoading(null);
    }
  };

  const successMessage = useMemo(() => {
    if (!applyResult) return null;
    if (applyResult.outcome === "already-installed") {
      return "Workflow already installed on production branch. No PR opened.";
    }
    if (applyResult.prUrl) {
      return `Workflow install ${applyResult.outcome}: ${applyResult.prUrl}`;
    }
    return `Workflow install ${applyResult.outcome} on branch ${applyResult.branchName}.`;
  }, [applyResult]);

  const upstreamBlockedReason = blockedByUpstream
    ? "Fix harness repo access before target workflow setup can be previewed."
    : undefined;
  const confirmDisabledReason = upstreamBlockedReason
    ? upstreamBlockedReason
    : variant === "advanced" && !previewIsCurrent
      ? "Generate a preview before you can confirm this write."
      : variant === "advanced" && preview?.validationError
        ? "Fix validation errors before confirming this write."
        : undefined;
  const applyDisabledReason =
    confirmDisabledReason ??
    (!confirmed
      ? variant === "guided"
        ? "Confirm before creating the workflow install PR."
        : "Confirm the preview before applying the workflow install PR."
      : undefined);

  const previewButtonLabel =
    variant === "guided" ? "Preview workflow install PR" : "Preview workflow PR";
  const applyButtonLabel =
    loading === "apply"
      ? "Creating PR…"
      : variant === "guided"
        ? repo.workflowStatus === "present"
          ? "Update workflow install PR"
          : "Create workflow install PR"
        : "Apply workflow PR";

  const confirmDisabled =
    variant === "advanced"
      ? !previewIsCurrent || Boolean(preview?.validationError) || blockedByUpstream
      : blockedByUpstream;

  return (
    <div
      className={
        variant === "guided"
          ? "space-y-4"
          : "rounded-md border border-border bg-muted/10 p-4 space-y-4"
      }
    >
      {variant === "advanced" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{repo.repoConfigId}</p>
            <p className="text-sm text-muted-foreground break-all">
              {repo.targetRepo}
            </p>
            <p className="text-xs text-muted-foreground">
              Production branch: {repo.productionBranch}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              label={`Access: ${repo.repoAccess}`}
              variant={accessVariant(repo.repoAccess)}
            />
            <StatusBadge
              label={`Workflow: ${workflowStatusLabel(repo.workflowStatus, variant)}`}
              variant={workflowVariant(repo.workflowStatus)}
            />
          </div>
        </div>
      ) : null}

      {variant === "guided" ? (
        <ReviewWorkflowChangesDisclosure
          open={disclosureOpen}
          onOpenChange={handleDisclosureOpenChange}
          isLoading={loading === "preview"}
          previewError={previewError ?? undefined}
          preview={preview ?? undefined}
          previewIsCurrent={previewIsCurrent}
        />
      ) : (
        <RemoteActionPreview
          targetWorkflowPreview={previewIsCurrent ? preview ?? undefined : undefined}
        />
      )}

      <RemoteActionConfirmation
        scope="remote-repo-write"
        variant={variant}
        confirmed={confirmed}
        disabled={confirmDisabled}
        disabledReason={confirmDisabledReason}
        onConfirmedChange={setConfirmed}
      />

      {variant === "guided" ? (
        <Button
          type="button"
          onClick={handleApply}
          disabled={
            loading !== null ||
            !confirmed ||
            blockedByUpstream
          }
        >
          {applyButtonLabel}
        </Button>
      ) : (
        <div className={FORM.actions}>
          <Button
            type="button"
            onClick={handlePreview}
            disabled={loading !== null || blockedByUpstream}
          >
            {loading === "preview" ? "Generating preview…" : previewButtonLabel}
          </Button>
          <Button
            type="button"
            onClick={handleApply}
            disabled={
              loading !== null ||
              !previewIsCurrent ||
              !confirmed ||
              Boolean(preview?.validationError) ||
              blockedByUpstream
            }
          >
            {applyButtonLabel}
          </Button>
        </div>
      )}

      {upstreamBlockedReason ? (
        <p className="text-sm text-muted-foreground">{upstreamBlockedReason}</p>
      ) : null}
      {applyDisabledReason && !upstreamBlockedReason ? (
        <p className="text-sm text-muted-foreground">{applyDisabledReason}</p>
      ) : null}

      {error ? <SetupApplyResult success={false} message={error} /> : null}
      {variant === "advanced" && successMessage ? (
        <SetupApplyResult success message={successMessage} />
      ) : null}
    </div>
  );
}
