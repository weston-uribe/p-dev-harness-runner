"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import {
  TargetRepoCreateConnect,
  type TargetRepoCreatedSummary,
  type TargetRepoSelectionMode,
} from "@/components/custom/target-repo-create-connect";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsMutationPanel } from "@/components/settings/settings-mutation-panel";
import {
  initialSettingsMutationState,
  sanitizeSettingsErrorMessage,
  type SettingsMutationState,
} from "@/lib/settings/settings-mutation";
import {
  applySettingsConfigPatch,
  previewSettingsConfigPatch,
} from "@/lib/settings/settings-setup-client";
import type { RepositoriesOverviewEntry } from "@/lib/settings/load-repositories-overview";

type RepoRowStatus = {
  status: "connected" | "needs-attention" | "unchecked" | "checking";
  detail?: string;
};

type RepositoriesSettingsEditorProps = {
  initialConfigForm: LocalConfigFormInput;
  initialConfigFingerprint: string;
  initialOverview: RepositoriesOverviewEntry[];
};

function displayRepoIdentity(targetRepo: string): string {
  const match = targetRepo.trim().match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return targetRepo || "Unnamed repository";
}

function statusLabel(status: RepoRowStatus["status"]): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs-attention":
      return "Needs attention";
    case "checking":
      return "Checking…";
    default:
      return "Not verified";
  }
}

export function RepositoriesSettingsEditor({
  initialConfigForm,
  initialConfigFingerprint,
  initialOverview,
}: RepositoriesSettingsEditorProps) {
  const [configForm, setConfigForm] = useState(initialConfigForm);
  const [configFingerprint, setConfigFingerprint] = useState(initialConfigFingerprint);
  const [rowStatus, setRowStatus] = useState<Record<string, RepoRowStatus>>(() => {
    const next: Record<string, RepoRowStatus> = {};
    for (const entry of initialOverview) {
      next[entry.id] = {
        status: entry.connectionStatus,
        detail: entry.connectionDetail,
      };
    }
    return next;
  });
  const [adding, setAdding] = useState(false);
  const [selectionMode, setSelectionMode] =
    useState<TargetRepoSelectionMode>("create");
  const [githubOwner, setGithubOwner] = useState<string | null>(null);
  const [githubOwnerLoading, setGithubOwnerLoading] = useState(false);
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [draftBaseBranch, setDraftBaseBranch] = useState("");
  const [draftProductionBranch, setDraftProductionBranch] = useState("");
  const [mutation, setMutation] =
    useState<SettingsMutationState<{ fingerprint: string; configPreview: string }>>(
      initialSettingsMutationState(),
    );
  const [confirmed, setConfirmed] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const overviewById = useMemo(() => {
    const map = new Map(initialOverview.map((entry) => [entry.id, entry]));
    return map;
  }, [initialOverview]);

  const editingRepo = configForm.repos.find((repo) => repo.id === editingRepoId) ?? null;

  const buildReposPatch = useCallback(
    (repos: LocalConfigFormInput["repos"]) => ({
      kind: "repos" as const,
      repos: repos.map((repo) => ({
        id: repo.id,
        targetRepo: repo.targetRepo,
        baseBranch: repo.baseBranch,
        productionBranch: repo.productionBranch,
      })),
    }),
    [],
  );

  const ensureGithubOwner = useCallback(async () => {
    setGithubOwnerLoading(true);
    try {
      const response = await fetch("/api/setup/verify-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "github" }),
      });
      const data = await response.json();
      if (response.ok && data.status === "connected" && data.label) {
        setGithubOwner(String(data.label));
      } else {
        setGithubOwner(null);
      }
    } catch {
      setGithubOwner(null);
    } finally {
      setGithubOwnerLoading(false);
    }
  }, []);

  const startAddRepository = useCallback(() => {
    setAdding(true);
    setEditingRepoId(null);
    setPageError(null);
    setMutation(initialSettingsMutationState());
    void ensureGithubOwner();
  }, [ensureGithubOwner]);

  const startEditBranches = useCallback(
    (repoId: string) => {
      const repo = configForm.repos.find((item) => item.id === repoId);
      if (!repo) {
        return;
      }
      setAdding(false);
      setEditingRepoId(repoId);
      setDraftBaseBranch(repo.baseBranch ?? "dev");
      setDraftProductionBranch(repo.productionBranch ?? "main");
      setConfirmed(false);
      setMutation(initialSettingsMutationState());
      setPageError(null);
    },
    [configForm.repos],
  );

  const verifyRepo = useCallback(
    async (repoId: string) => {
      const repo = configForm.repos.find((item) => item.id === repoId);
      if (!repo?.targetRepo) {
        return;
      }
      setRowStatus((current) => ({
        ...current,
        [repoId]: { status: "checking" },
      }));
      setPageError(null);
      try {
        const response = await fetch("/api/setup/verify-target-repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetRepo: repo.targetRepo,
            baseBranch: repo.baseBranch,
            productionBranch: repo.productionBranch,
            repoConfigId: repo.id,
          }),
        });
        const data = await response.json();
        if (!response.ok || data.status === "failed") {
          setRowStatus((current) => ({
            ...current,
            [repoId]: {
              status: "needs-attention",
              detail:
                data.error ??
                data.message ??
                "Repository verification failed.",
            },
          }));
          return;
        }
        setRowStatus((current) => ({
          ...current,
          [repoId]: {
            status: "connected",
            detail: data.message,
          },
        }));
      } catch (error) {
        setRowStatus((current) => ({
          ...current,
          [repoId]: {
            status: "needs-attention",
            detail:
              error instanceof Error
                ? error.message
                : "Repository verification failed.",
          },
        }));
      }
    },
    [configForm.repos],
  );

  const removeFromPDev = useCallback(
    async (repoId: string) => {
      const repo = configForm.repos.find((item) => item.id === repoId);
      if (!repo) {
        return;
      }
      if (configForm.repos.length <= 1) {
        setPageError("At least one target repository must remain configured.");
        return;
      }

      const overview = overviewById.get(repoId);
      const dependencies = overview?.detachDependencies ?? [];
      if (dependencies.length > 0 || (overview?.linearAssociationCount ?? 0) > 0) {
        const lines =
          dependencies.length > 0
            ? dependencies.map((dep) => `- ${dep.summary}`).join("\n")
            : "- Active Linear team/project mappings";
        setPageError(
          `Cannot remove "${displayRepoIdentity(repo.targetRepo)}" from PDev while active dependencies remain.\n\n${lines}\n\nRemove or remap these on Settings → Linear first.`,
        );
        return;
      }

      const identity = displayRepoIdentity(repo.targetRepo);
      const confirmedRemove = window.confirm(
        `Remove “${identity}” from PDev? PDev will stop processing work for this repository. The GitHub repository and its contents will not be deleted.`,
      );
      if (!confirmedRemove) {
        return;
      }

      const nextRepos = configForm.repos.filter((item) => item.id !== repoId);
      setPageError(null);
      setMutation({
        phase: "applying",
        preview: null,
        error: null,
        successMessage: null,
      });
      try {
        const result = await applySettingsConfigPatch({
          patch: buildReposPatch(nextRepos),
          expectedConfigFingerprint: configFingerprint,
        });
        setConfigForm((current) => ({ ...current, repos: nextRepos }));
        setConfigFingerprint(result.configFingerprint);
        setMutation({
          phase: "success",
          preview: null,
          error: null,
          successMessage: `${identity} removed from PDev. The GitHub repository was not deleted.`,
        });
        if (editingRepoId === repoId) {
          setEditingRepoId(null);
        }
      } catch (error) {
        setMutation({
          phase: "error",
          preview: null,
          error: sanitizeSettingsErrorMessage(
            error instanceof Error ? error.message : "Remove from PDev failed.",
          ),
          successMessage: null,
        });
      }
    },
    [
      buildReposPatch,
      configFingerprint,
      configForm.repos,
      editingRepoId,
      overviewById,
    ],
  );

  const runBranchPreview = useCallback(async () => {
    if (!editingRepo) {
      return;
    }
    const nextRepos = configForm.repos.map((repo) =>
      repo.id === editingRepo.id
        ? {
            ...repo,
            baseBranch: draftBaseBranch.trim(),
            productionBranch: draftProductionBranch.trim(),
          }
        : repo,
    );
    setMutation((current) => ({ ...current, phase: "previewing", error: null }));
    setConfirmed(false);
    try {
      const preview = await previewSettingsConfigPatch({
        patch: buildReposPatch(nextRepos),
        verifyBranches: true,
        requireDistinctBranches: true,
      });
      setMutation({
        phase: "preview-ready",
        preview,
        error: null,
        successMessage: null,
      });
    } catch (error) {
      setMutation({
        phase: "error",
        preview: null,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Branch preview failed.",
        ),
        successMessage: null,
      });
    }
  }, [
    buildReposPatch,
    configForm.repos,
    draftBaseBranch,
    draftProductionBranch,
    editingRepo,
  ]);

  const runBranchApply = useCallback(async () => {
    if (!editingRepo || !confirmed) {
      return;
    }
    const nextRepos = configForm.repos.map((repo) =>
      repo.id === editingRepo.id
        ? {
            ...repo,
            baseBranch: draftBaseBranch.trim(),
            productionBranch: draftProductionBranch.trim(),
          }
        : repo,
    );
    setMutation((current) => ({ ...current, phase: "applying", error: null }));
    try {
      // Fresh server-authoritative plan on apply; do not rely solely on last preview.
      await previewSettingsConfigPatch({
        patch: buildReposPatch(nextRepos),
        verifyBranches: true,
        requireDistinctBranches: true,
      });
      const result = await applySettingsConfigPatch({
        patch: buildReposPatch(nextRepos),
        expectedConfigFingerprint: configFingerprint,
        verifyBranches: true,
        requireDistinctBranches: true,
      });
      setConfigForm((current) => ({ ...current, repos: nextRepos }));
      setConfigFingerprint(result.configFingerprint);
      setMutation({
        phase: "success",
        preview: null,
        error: null,
        successMessage: "Branches updated. Hidden repository fields were left unchanged.",
      });
      setConfirmed(false);
      void verifyRepo(editingRepo.id);
    } catch (error) {
      setMutation({
        phase: "error",
        preview: mutation.preview,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Branch apply failed.",
        ),
        successMessage: null,
      });
    }
  }, [
    buildReposPatch,
    confirmed,
    configFingerprint,
    configForm.repos,
    draftBaseBranch,
    draftProductionBranch,
    editingRepo,
    mutation.preview,
    verifyRepo,
  ]);

  const persistCreatedRepo = useCallback(
    async (summary: TargetRepoCreatedSummary) => {
      const nextRepos = [
        ...configForm.repos,
        {
          id: summary.resultingTargetRepoConfigId,
          targetRepo: summary.repositoryUrl,
          baseBranch: "dev",
          productionBranch: "main",
        },
      ];
      setMutation({
        phase: "applying",
        preview: null,
        error: null,
        successMessage: null,
      });
      try {
        const result = await applySettingsConfigPatch({
          patch: buildReposPatch(nextRepos),
          expectedConfigFingerprint: configFingerprint,
          verifyBranches: true,
          requireDistinctBranches: true,
        });
        setConfigForm((current) => ({ ...current, repos: nextRepos }));
        setConfigFingerprint(result.configFingerprint);
        setAdding(false);
        setMutation({
          phase: "success",
          preview: null,
          error: null,
          successMessage: `${summary.repositoryFullName} added to PDev.`,
        });
        void verifyRepo(summary.resultingTargetRepoConfigId);
      } catch (error) {
        setMutation({
          phase: "error",
          preview: null,
          error: sanitizeSettingsErrorMessage(
            error instanceof Error ? error.message : "Failed to save new repository.",
          ),
          successMessage: null,
        });
      }
    },
    [buildReposPatch, configFingerprint, configForm.repos, verifyRepo],
  );

  const connectExistingRepo = useCallback(
    async (targetRepo: string) => {
      const trimmed = targetRepo.trim();
      if (!trimmed) {
        setPageError("Enter a GitHub repository URL to connect.");
        return;
      }
      const rowId = `repo-${Date.now()}`;
      const nextRepos = [
        ...configForm.repos,
        {
          id: rowId,
          targetRepo: trimmed,
          baseBranch: "dev",
          productionBranch: "main",
        },
      ];
      setMutation({
        phase: "applying",
        preview: null,
        error: null,
        successMessage: null,
      });
      try {
        const verifyResponse = await fetch("/api/setup/verify-target-repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetRepo: trimmed,
            baseBranch: "dev",
            productionBranch: "main",
            repoConfigId: rowId,
          }),
        });
        const verifyData = await verifyResponse.json();
        if (!verifyResponse.ok || verifyData.status === "failed") {
          throw new Error(
            verifyData.error ??
              verifyData.message ??
              "Repository verification failed.",
          );
        }
        const result = await applySettingsConfigPatch({
          patch: buildReposPatch(nextRepos),
          expectedConfigFingerprint: configFingerprint,
          verifyBranches: true,
          requireDistinctBranches: true,
        });
        setConfigForm((current) => ({ ...current, repos: nextRepos }));
        setConfigFingerprint(result.configFingerprint);
        setAdding(false);
        setMutation({
          phase: "success",
          preview: null,
          error: null,
          successMessage: `${displayRepoIdentity(trimmed)} connected to PDev.`,
        });
        setRowStatus((current) => ({
          ...current,
          [rowId]: { status: "connected", detail: verifyData.message },
        }));
      } catch (error) {
        setMutation({
          phase: "error",
          preview: null,
          error: sanitizeSettingsErrorMessage(
            error instanceof Error ? error.message : "Connect repository failed.",
          ),
          successMessage: null,
        });
      }
    },
    [buildReposPatch, configFingerprint, configForm.repos],
  );

  const [connectDraftUrl, setConnectDraftUrl] = useState("");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Add, connect, verify, edit branches, and detach repositories that PDev may modify.
        </p>
        <Button type="button" size="sm" onClick={startAddRepository}>
          Add repository
        </Button>
      </div>

      {pageError ? (
        <p className="whitespace-pre-wrap text-sm text-destructive">{pageError}</p>
      ) : null}
      {mutation.error && !editingRepoId ? (
        <p className="whitespace-pre-wrap text-sm text-destructive">{mutation.error}</p>
      ) : null}
      {mutation.successMessage && !editingRepoId ? (
        <p className="text-sm text-muted-foreground">{mutation.successMessage}</p>
      ) : null}

      <ul className="space-y-3">
        {configForm.repos.map((repo) => {
          const status = rowStatus[repo.id] ?? { status: "unchecked" as const };
          const overview = overviewById.get(repo.id);
          return (
            <li
              key={repo.id}
              className="space-y-3 rounded-md border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="break-all font-medium">
                    {displayRepoIdentity(repo.targetRepo)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {(repo.baseBranch || overview?.baseBranch || "dev") +
                      " → " +
                      (repo.productionBranch ||
                        overview?.productionBranch ||
                        "main")}
                  </p>
                  {status.status === "needs-attention" && status.detail ? (
                    <p className="text-sm text-destructive">{status.detail}</p>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {statusLabel(status.status)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void verifyRepo(repo.id)}
                >
                  Verify or repair
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => startEditBranches(repo.id)}
                >
                  Edit branches
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void removeFromPDev(repo.id)}
                >
                  Remove from PDev
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Add repository</h3>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
          <TargetRepoCreateConnect
            mode={selectionMode}
            onModeChange={setSelectionMode}
            githubOwner={githubOwner}
            githubOwnerLoading={githubOwnerLoading}
            onRepoCreated={(summary) => void persistCreatedRepo(summary)}
            onInvalidatePreview={() => {
              setMutation(initialSettingsMutationState());
            }}
            connectContent={
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="settings-connect-repo-url">
                    Existing repository URL
                  </Label>
                  <Input
                    id="settings-connect-repo-url"
                    value={connectDraftUrl}
                    onChange={(event) => setConnectDraftUrl(event.target.value)}
                    placeholder="https://github.com/owner/repository"
                    autoComplete="off"
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => void connectExistingRepo(connectDraftUrl)}
                >
                  Verify and connect
                </Button>
              </div>
            }
          />
        </div>
      ) : null}

      {editingRepo ? (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">
              Edit branches — {displayRepoIdentity(editingRepo.targetRepo)}
            </h3>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditingRepoId(null)}
            >
              Cancel
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-dev-branch">Development branch</Label>
              <Input
                id="settings-dev-branch"
                value={draftBaseBranch}
                onChange={(event) => {
                  setDraftBaseBranch(event.target.value);
                  setConfirmed(false);
                  setMutation(initialSettingsMutationState());
                }}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-prod-branch">Production branch</Label>
              <Input
                id="settings-prod-branch"
                value={draftProductionBranch}
                onChange={(event) => {
                  setDraftProductionBranch(event.target.value);
                  setConfirmed(false);
                  setMutation(initialSettingsMutationState());
                }}
                autoComplete="off"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Both branches must already exist on GitHub. Changing branches does not
            alter Linear mappings, deployment settings, models, or validation
            commands.
          </p>
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Checkbox
              id="confirm-branch-edit"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <Label htmlFor="confirm-branch-edit" className="text-sm leading-snug">
              I understand PDev will update only the development and production
              branch settings for this repository in local harness config. Existing
              Linear mappings, deployment settings, models, and validation commands
              remain unchanged.
            </Label>
          </div>
          <SettingsMutationPanel
            title="Apply branch changes"
            phase={mutation.phase}
            error={mutation.error}
            successMessage={mutation.successMessage}
            previewSummary={mutation.preview?.configPreview ?? null}
            previewPolicy="optional"
            confirmed={confirmed}
            onConfirmedChange={setConfirmed}
            onPreview={() => void runBranchPreview()}
            onApply={() => void runBranchApply()}
            disablePreview={
              !draftBaseBranch.trim() || !draftProductionBranch.trim()
            }
            disableApply={
              !confirmed ||
              !draftBaseBranch.trim() ||
              !draftProductionBranch.trim()
            }
          />
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Linear team and project mappings are managed in{" "}
        <Link href="/settings/linear" className="underline">
          Settings → Linear
        </Link>
        . Deployment settings are managed in{" "}
        <Link href="/settings/deployments" className="underline">
          Settings → Deployments
        </Link>
        .
      </p>
    </div>
  );
}
