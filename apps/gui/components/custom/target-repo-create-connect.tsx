"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  TargetRepoProvisioningApplyResult,
  TargetRepoProvisioningPreview,
} from "@harness/setup/target-repo-provisioning";
import { FORM } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { GuidedSelect } from "@/components/ui/guided-select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/custom/status-badge";
import { ConnectedStatusMessage } from "@/components/custom/connected-status";

export type TargetRepoSelectionMode = "create" | "connect";

export interface TargetRepoCreatedSummary {
  repositoryUrl: string;
  repositoryFullName: string;
  resultingTargetRepoConfigId: string;
}

interface TargetRepoCreateConnectProps {
  mode: TargetRepoSelectionMode;
  onModeChange: (mode: TargetRepoSelectionMode) => void;
  githubOwner?: string | null;
  githubOwnerLoading?: boolean;
  onRepoCreated: (summary: TargetRepoCreatedSummary) => void;
  onInvalidatePreview: () => void;
  connectContent: React.ReactNode;
}

export function TargetRepoCreateConnect({
  mode,
  onModeChange,
  githubOwner,
  githubOwnerLoading = false,
  onRepoCreated,
  onInvalidatePreview,
  connectContent,
}: TargetRepoCreateConnectProps) {
  const [repositoryName, setRepositoryName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [preview, setPreview] = useState<TargetRepoProvisioningPreview | null>(
    null,
  );
  const [previewGenerated, setPreviewGenerated] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<TargetRepoProvisioningApplyResult | null>(null);
  const [createdSummary, setCreatedSummary] =
    useState<TargetRepoCreatedSummary | null>(null);

  const previewIsCurrent = preview !== null && previewGenerated;
  const owner = githubOwner?.trim() ?? "";

  const invalidateProvisioningPreview = useCallback(() => {
    setPreview(null);
    setPreviewGenerated(false);
    setConfirmed(false);
    setPreviewError(null);
    setApplyResult(null);
  }, []);

  useEffect(() => {
    invalidateProvisioningPreview();
    onInvalidatePreview();
  }, [repositoryName, description, visibility, invalidateProvisioningPreview, onInvalidatePreview]);

  const buildPreviewPayload = useCallback(
    () => ({
      owner,
      name: repositoryName.trim(),
      description: description.trim() || undefined,
      visibility,
      ...(preview?.operationId ? { operationId: preview.operationId } : {}),
      ...(preview?.creationActionId
        ? { creationActionId: preview.creationActionId }
        : {}),
      ...(preview?.createdAt ? { createdAt: preview.createdAt } : {}),
    }),
    [
      description,
      owner,
      preview?.creationActionId,
      preview?.createdAt,
      preview?.operationId,
      repositoryName,
      visibility,
    ],
  );

  const runPreview = useCallback(async () => {
    const response = await fetch("/api/setup/preview-target-repo-provisioning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPreviewPayload()),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Repository preview failed");
    }
    const nextPreview = data as TargetRepoProvisioningPreview;
    setPreview(nextPreview);
    setPreviewGenerated(true);
    return nextPreview;
  }, [buildPreviewPayload]);

  const handlePreview = useCallback(async () => {
    setLoading("preview");
    setError(null);
    setPreviewError(null);
    setConfirmed(false);
    setApplyResult(null);
    try {
      await runPreview();
    } catch (previewFailure) {
      setPreview(null);
      setPreviewGenerated(false);
      setPreviewError(
        previewFailure instanceof Error
          ? previewFailure.message
          : "Repository preview failed",
      );
    } finally {
      setLoading(null);
    }
  }, [runPreview]);

  const handleApply = useCallback(async () => {
    if (!confirmed || !owner || !repositoryName.trim()) {
      return;
    }

    setLoading("apply");
    setError(null);
    try {
      const currentPreview =
        previewIsCurrent && preview ? preview : await runPreview();

      if (
        currentPreview.state !== "preview-ready" &&
        currentPreview.state !== "preview-stale"
      ) {
        throw new Error(currentPreview.message ?? "Repository preview is not ready.");
      }

      const response = await fetch("/api/setup/apply-target-repo-provisioning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          name: repositoryName.trim(),
          description: description.trim() || undefined,
          visibility,
          operationId: currentPreview.operationId,
          creationActionId: currentPreview.creationActionId,
          createdAt: currentPreview.createdAt,
          fingerprint: currentPreview.fingerprint,
          confirmed: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Repository creation failed");
      }

      const apply = data as TargetRepoProvisioningApplyResult;
      setApplyResult(apply);

      if (apply.state !== "verified-complete") {
        throw new Error(apply.message ?? "Repository creation did not complete.");
      }

      if (!apply.repositoryUrl || !apply.repositoryFullName) {
        throw new Error("Repository creation finished without a repository URL.");
      }

      const summary: TargetRepoCreatedSummary = {
        repositoryUrl: apply.repositoryUrl,
        repositoryFullName: apply.repositoryFullName,
        resultingTargetRepoConfigId:
          currentPreview.resultingTargetRepoConfigId ||
          `target-${repositoryName.trim()}`,
      };
      setCreatedSummary(summary);
      invalidateProvisioningPreview();
      onRepoCreated(summary);
    } catch (applyFailure) {
      setError(
        applyFailure instanceof Error
          ? applyFailure.message
          : "Repository creation failed",
      );
    } finally {
      setLoading(null);
    }
  }, [
    confirmed,
    description,
    invalidateProvisioningPreview,
    onRepoCreated,
    owner,
    preview,
    previewIsCurrent,
    repositoryName,
    runPreview,
    visibility,
  ]);

  const previewReady =
    previewIsCurrent && preview?.state === "preview-ready";
  const canPreview =
    Boolean(owner) &&
    Boolean(repositoryName.trim()) &&
    loading === null &&
    !githubOwnerLoading;
  const canApply =
    previewReady &&
    confirmed &&
    loading === null &&
    Boolean(owner) &&
    Boolean(repositoryName.trim());

  return (
    <div className="space-y-6">
      <div className={FORM.fieldStack}>
        <Label htmlFor="target-repo-selection-mode">Target repository</Label>
        <GuidedSelect
          id="target-repo-selection-mode"
          value={mode}
          onChange={(event) => {
            onModeChange(event.target.value as TargetRepoSelectionMode);
            invalidateProvisioningPreview();
          }}
        >
          <option value="create">Create new product repository</option>
          <option value="connect">Connect existing repository</option>
        </GuidedSelect>
        <p className={FORM.secretHint}>
          Create provisions a technology-neutral GitHub repository with `main`,
          `dev`, `README.md`, and `.p-dev/product.json`. Connect uses an
          existing repo URL you verify in the next step.
        </p>
      </div>

      {mode === "create" ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Create new product</p>
            {createdSummary ? (
              <StatusBadge label="Repository created" variant="success" />
            ) : (
              <StatusBadge label="Not created yet" variant="secondary" />
            )}
          </div>

          <div className={FORM.fieldGrid}>
            <div className={FORM.fieldStack}>
              <Label htmlFor="target-repo-owner">GitHub owner</Label>
              <Input
                id="target-repo-owner"
                value={owner}
                readOnly
                placeholder={
                  githubOwnerLoading ? "Loading GitHub account…" : "Connect GitHub in Step 1"
                }
              />
              <p className={FORM.secretHint}>
                New repositories are created under the authenticated GitHub user
                from Step 1.
              </p>
            </div>
            <div className={FORM.fieldStack}>
              <Label htmlFor="target-repo-name">Repository name</Label>
              <Input
                id="target-repo-name"
                value={repositoryName}
                onChange={(event) => setRepositoryName(event.target.value)}
                placeholder="my-product"
                autoComplete="off"
              />
            </div>
            <div className={FORM.fieldStack}>
              <Label htmlFor="target-repo-visibility">Visibility</Label>
              <GuidedSelect
                id="target-repo-visibility"
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as "private" | "public")
                }
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </GuidedSelect>
            </div>
          </div>

          <div className={FORM.fieldStack}>
            <Label htmlFor="target-repo-description">Description (optional)</Label>
            <Textarea
              id="target-repo-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="Short product description for the new GitHub repository."
            />
          </div>

          {previewIsCurrent && preview ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
              <p className="font-medium">Repository preview</p>
              <p className="text-muted-foreground">{preview.message}</p>
              {preview.actionsWillPerform.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {preview.actionsWillPerform.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              ) : null}
              {preview.actionsWillNotPerform.length > 0 ? (
                <>
                  <p className="font-medium">Will not perform</p>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {preview.actionsWillNotPerform.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {preview.connectExistingHint ? (
                <p className="text-muted-foreground">
                  Existing repository hint: {preview.connectExistingHint}
                </p>
              ) : null}
            </div>
          ) : null}

          {previewError ? (
            <ConnectedStatusMessage message={previewError} failed />
          ) : null}

          <div className={FORM.confirmationBox}>
            <p className="text-sm font-medium">Confirm repository creation</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                Creates a new GitHub repository with generic bootstrap files only.
              </li>
              <li>
                Does not write local `.harness/config.local.json` or `.env.local`
                until you preview and confirm local setup files separately.
              </li>
              <li>
                Does not install stack-specific CI or application deployment
                configuration.
              </li>
            </ul>
            <div className="flex items-start gap-3">
              <Checkbox
                id="confirm-target-repo-create"
                checked={confirmed}
                disabled={!previewReady}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <Label
                htmlFor="confirm-target-repo-create"
                className="text-sm leading-snug"
              >
                I reviewed the repository preview and want to create this GitHub
                repository.
              </Label>
            </div>
            {!previewReady ? (
              <p className="text-sm text-muted-foreground">
                Generate a repository preview before confirming creation.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={!canPreview}
            >
              {loading === "preview"
                ? "Generating preview…"
                : "Preview repository creation"}
            </Button>
            <Button
              type="button"
              onClick={() => void handleApply()}
              disabled={!canApply}
            >
              {loading === "apply" ? "Creating repository…" : "Create repository"}
            </Button>
          </div>

          {error ? <ConnectedStatusMessage message={error} failed /> : null}
          {applyResult?.state === "verified-complete" && createdSummary ? (
            <ConnectedStatusMessage
              message={`${applyResult.message} Local harness config is not written until you preview and confirm local setup files below.`}
            />
          ) : null}
        </div>
      ) : (
        connectContent
      )}
    </div>
  );
}
