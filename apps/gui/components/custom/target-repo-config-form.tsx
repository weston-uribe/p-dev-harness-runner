"use client";

import { useState } from "react";
import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import { FORM } from "@/lib/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/custom/status-badge";
import { RepoIcon } from "@/components/custom/service-icons";
import { ConnectedStatusMessage } from "@/components/custom/connected-status";
import type { GuidedRepoRow } from "@/lib/verification-state";
import {
  isRepoFailedForActiveToken,
  isRepoVerifiedForActiveToken,
} from "@/lib/verification-state";
import { cn } from "@/lib/utils";

export type RepoVerificationUiState =
  | "unchecked"
  | "checking"
  | "connected"
  | "failed";

export interface RepoVerificationUi {
  state: RepoVerificationUiState;
  verifiedTargetRepo?: string;
  attemptedTargetRepo?: string;
  verifiedGithubTokenFingerprint?: string;
  attemptedGithubTokenFingerprint?: string;
  message?: string;
  repoSlug?: string;
  limitation?: string;
  workflowInstallReady?: boolean;
}

export interface HarnessRepoVerificationUi {
  state: RepoVerificationUiState;
  verifiedRepo?: string;
  verifiedGithubTokenFingerprint?: string;
  message?: string;
  limitation?: string;
}

const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

interface TargetRepoConfigFormProps {
  values: LocalConfigFormInput;
  highlightStaleTarget?: boolean;
  variant?: "guided-minimal" | "advanced";
  guidedSection?: "full" | "harness" | "target-repos";
  suggestedHarnessDispatchRepo?: string;
  savedHarnessDispatchRepository?: string;
  harnessRepoVerification?: HarnessRepoVerificationUi;
  verifyingHarnessRepo?: boolean;
  guidedRepos?: GuidedRepoRow[];
  repoVerification?: Record<string, RepoVerificationUi>;
  verifyingRepoRowId?: string | null;
  onChange: (values: LocalConfigFormInput) => void;
  onGuidedReposChange?: (repos: GuidedRepoRow[]) => void;
  onVerifyRepo?: (rowId: string) => void;
  onRepoBlur?: (rowId: string) => void;
  onAddRepo?: () => void;
  onRemoveRepo?: (rowId: string) => void;
  harnessDispatchRepository?: string;
  onHarnessDispatchRepositoryChange?: (value: string) => void;
  onVerifyAndUseHarnessRepo?: (draftRepo: string) => void;
  harnessConnectedAutomatically?: boolean;
  harnessRepoInheritedFromStep1?: boolean;
  githubTokenSourceHint?: string;
  activeGithubTokenFingerprint?: string | null;
}

export function TargetRepoConfigForm({
  values,
  highlightStaleTarget = false,
  variant = "advanced",
  guidedSection = "full",
  suggestedHarnessDispatchRepo,
  savedHarnessDispatchRepository = "",
  harnessRepoVerification = { state: "unchecked" },
  verifyingHarnessRepo = false,
  guidedRepos,
  repoVerification = {},
  verifyingRepoRowId = null,
  onChange,
  onGuidedReposChange,
  onVerifyRepo,
  onRepoBlur,
  onAddRepo,
  onRemoveRepo,
  harnessDispatchRepository = "",
  onHarnessDispatchRepositoryChange,
  onVerifyAndUseHarnessRepo,
  harnessConnectedAutomatically = false,
  harnessRepoInheritedFromStep1 = false,
  githubTokenSourceHint,
  activeGithubTokenFingerprint = null,
}: TargetRepoConfigFormProps) {
  const [showBranchSettings, setShowBranchSettings] = useState<
    Record<string, boolean>
  >({});
  const [editingHarnessRepo, setEditingHarnessRepo] = useState(false);
  const [draftHarnessRepo, setDraftHarnessRepo] = useState(
    harnessDispatchRepository,
  );

  const effectiveHarnessRepo =
    harnessDispatchRepository.trim() ||
    savedHarnessDispatchRepository.trim() ||
    suggestedHarnessDispatchRepo?.trim() ||
    "";
  const harnessRepoSource = savedHarnessDispatchRepository.trim()
    ? "Saved in .env.local"
    : suggestedHarnessDispatchRepo?.trim()
      ? "Detected from git remote"
      : "Not detected yet";
  const activeHarnessRepo = harnessDispatchRepository.trim();
  const harnessRepoVerified =
    harnessRepoVerification.state === "connected" &&
    harnessRepoVerification.verifiedRepo === activeHarnessRepo &&
    (!activeGithubTokenFingerprint ||
      harnessRepoVerification.verifiedGithubTokenFingerprint ===
        activeGithubTokenFingerprint);

  const updateRepo = (index: number, patch: Partial<(typeof values.repos)[0]>) => {
    const repos = [...values.repos];
    repos[index] = { ...(repos[index] ?? { id: "", targetRepo: "" }), ...patch };
    onChange({ ...values, repos });
  };

  const updateGuidedRepo = (
    rowId: string,
    patch: Partial<Omit<GuidedRepoRow, "rowId">>,
  ) => {
    if (!guidedRepos || !onGuidedReposChange) {
      return;
    }
    onGuidedReposChange(
      guidedRepos.map((row) =>
        row.rowId === rowId ? { ...row, ...patch } : row,
      ),
    );
  };

  if (variant === "guided-minimal") {
    const repos =
      guidedRepos && guidedRepos.length > 0
        ? guidedRepos
        : [{ rowId: "fallback-repo", id: "", targetRepo: "" }];
    const showHarnessSection =
      guidedSection === "full" || guidedSection === "harness";
    const showTargetRepoSection =
      guidedSection === "full" || guidedSection === "target-repos";

    return (
      <div className="space-y-6">
        {showHarnessSection ? (
        <div className={FORM.fieldStack}>
          <Label htmlFor="harness-dispatch-repository-guided">Harness workspace</Label>
          {!editingHarnessRepo ? (
            <>
              <p className="text-sm font-medium break-all">
                {activeHarnessRepo || effectiveHarnessRepo || "Not connected yet"}
              </p>
              <p className={FORM.secretHint}>
                This is the private GitHub repo where harness GitHub Actions
                secrets and future dispatch/workflow setup are configured. It is
                not your target app repo.
              </p>
              {harnessConnectedAutomatically ? (
                <p className={FORM.secretHint}>
                  Connected automatically during Step 1.
                </p>
              ) : harnessRepoInheritedFromStep1 ? (
                <p className={FORM.secretHint}>
                  Connected during Step 1. You can use a different harness repo if
                  needed.
                </p>
              ) : (
                <p className={FORM.secretHint}>{harnessRepoSource}</p>
              )}
              {savedHarnessDispatchRepository.trim() &&
              suggestedHarnessDispatchRepo?.trim() &&
              savedHarnessDispatchRepository.trim() !==
                suggestedHarnessDispatchRepo.trim() ? (
                <p className={FORM.secretHint}>
                  Detected git remote: {suggestedHarnessDispatchRepo}. Your saved
                  override in `.env.local` takes precedence.
                </p>
              ) : null}
              {!savedHarnessDispatchRepository.trim() &&
              suggestedHarnessDispatchRepo?.trim() &&
              effectiveHarnessRepo === suggestedHarnessDispatchRepo ? (
                <p className={FORM.secretHint}>
                  If this detected repo is correct, you do not need to change it.
                </p>
              ) : null}
              {harnessRepoVerified && harnessRepoVerification.message ? (
                <ConnectedStatusMessage message={harnessRepoVerification.message} />
              ) : null}
              {!harnessConnectedAutomatically &&
              !harnessRepoInheritedFromStep1 &&
              !harnessRepoVerified &&
              activeHarnessRepo ? (
                <p className={FORM.secretHint}>
                  Verify and use this harness repo before creating local setup
                  files.
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraftHarnessRepo(activeHarnessRepo || effectiveHarnessRepo);
                  setEditingHarnessRepo(true);
                }}
              >
                {harnessConnectedAutomatically
                  ? "Use a different or existing harness repo"
                  : activeHarnessRepo
                    ? "Update harness repo"
                    : "Enter harness repo"}
              </Button>
            </>
          ) : (
            <>
              <Input
                id="harness-dispatch-repository-guided"
                value={draftHarnessRepo}
                onChange={(event) => setDraftHarnessRepo(event.target.value)}
                autoComplete="off"
              />
              <p className={FORM.secretHint}>
                Enter the harness repo slug or GitHub URL. Saving to `.env.local`
                happens when you verify and use this repo, then create or update
                local setup files.
              </p>
              {harnessRepoVerification.state === "failed" &&
              harnessRepoVerification.message ? (
                <ConnectedStatusMessage
                  message={harnessRepoVerification.message}
                  failed
                />
              ) : null}
              {harnessRepoVerification.limitation ? (
                <p className="text-xs text-muted-foreground">
                  {harnessRepoVerification.limitation}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {onVerifyAndUseHarnessRepo ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onVerifyAndUseHarnessRepo(draftHarnessRepo)}
                    disabled={verifyingHarnessRepo || !draftHarnessRepo.trim()}
                  >
                    {verifyingHarnessRepo
                      ? "Verifying harness repo…"
                      : "Verify and use harness repo"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraftHarnessRepo(activeHarnessRepo || effectiveHarnessRepo);
                    setEditingHarnessRepo(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
        ) : null}

        {showTargetRepoSection ? (
        <div className="space-y-4">
          {repos.map((repo, index) => {
            const verification = repoVerification[repo.rowId] ?? {
              state: "unchecked" as const,
            };
            const badge = repoVerificationBadge(verification.state);
            const trimmedUrl = repo.targetRepo.trim();
            const verifiedForCurrentUrl = isRepoVerifiedForActiveToken(
              verification,
              trimmedUrl,
              activeGithubTokenFingerprint,
            );
            const failedForCurrentUrl = isRepoFailedForActiveToken(
              verification,
              trimmedUrl,
              activeGithubTokenFingerprint,
            );

            const verifyButtonLabel =
              verifyingRepoRowId === repo.rowId
                ? "Checking repo + workflow access…"
                : verifiedForCurrentUrl
                  ? "Verified"
                  : "Verify repo + workflow access";

            const verifyButtonDisabled =
              verifyingRepoRowId === repo.rowId ||
              verifiedForCurrentUrl ||
              !GITHUB_REPO_URL_PATTERN.test(trimmedUrl);

            return (
              <div
                key={repo.rowId}
                className="rounded-lg border border-border bg-card p-4 space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="inline-flex items-center gap-2 text-sm font-medium">
                    <RepoIcon />
                    <span>Target repo {index + 1}</span>
                  </p>
                  <StatusBadge label={badge.label} variant={badge.variant} />
                </div>

                <div className={FORM.fieldStack}>
                  <Label htmlFor={`target-repo-${repo.rowId}`}>
                    Target repo URL
                  </Label>
                  <Input
                    id={`target-repo-${repo.rowId}`}
                    value={repo.targetRepo}
                    onChange={(event) =>
                      updateGuidedRepo(repo.rowId, {
                        targetRepo: event.target.value,
                      })
                    }
                    onBlur={() => onRepoBlur?.(repo.rowId)}
                    placeholder="https://github.com/acme/my-product"
                    className={
                      highlightStaleTarget && index === 0
                        ? "border-destructive/60"
                        : undefined
                    }
                    autoComplete="off"
                  />
                  <p className={FORM.secretHint}>Copy-paste the main repo URL.</p>
                  {highlightStaleTarget && index === 0 ? (
                    <p className={FORM.secretHint}>
                      Enter the target repo you actually intend to use. The app
                      will not guess or invent a replacement repo for you.
                    </p>
                  ) : null}
                </div>

                {verifiedForCurrentUrl ? (
                  <ConnectedStatusMessage message="Connected" />
                ) : failedForCurrentUrl && verification.message ? (
                  <ConnectedStatusMessage
                    message={verification.message}
                    failed
                  />
                ) : null}

                {verification.limitation &&
                (verifiedForCurrentUrl || failedForCurrentUrl) ? (
                  <p className="text-xs text-muted-foreground">
                    {verification.limitation}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {onVerifyRepo ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onVerifyRepo(repo.rowId)}
                      disabled={verifyButtonDisabled}
                    >
                      {verifyButtonLabel}
                    </Button>
                  ) : null}
                  {index > 0 && onRemoveRepo ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemoveRepo(repo.rowId)}
                    >
                      Remove repo
                    </Button>
                  ) : null}
                </div>

                <div className={FORM.fieldStack}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setShowBranchSettings((current) => ({
                        ...current,
                        [repo.rowId]: !current[repo.rowId],
                      }))
                    }
                  >
                    {showBranchSettings[repo.rowId]
                      ? "Hide advanced branch settings"
                      : "Advanced branch settings"}
                  </Button>
                  {showBranchSettings[repo.rowId] ? (
                    <div className={FORM.fieldGrid}>
                      <div className={FORM.fieldStack}>
                        <Label htmlFor={`guided-base-branch-${repo.rowId}`}>
                          Base branch
                        </Label>
                        <Input
                          id={`guided-base-branch-${repo.rowId}`}
                          value={repo.baseBranch ?? ""}
                          onChange={(event) =>
                            updateGuidedRepo(repo.rowId, {
                              baseBranch: event.target.value,
                            })
                          }
                          placeholder="dev"
                          autoComplete="off"
                        />
                      </div>
                      <div className={FORM.fieldStack}>
                        <Label htmlFor={`guided-production-branch-${repo.rowId}`}>
                          Production branch
                        </Label>
                        <Input
                          id={`guided-production-branch-${repo.rowId}`}
                          value={repo.productionBranch ?? ""}
                          onChange={(event) =>
                            updateGuidedRepo(repo.rowId, {
                              productionBranch: event.target.value,
                            })
                          }
                          placeholder="main"
                          autoComplete="off"
                        />
                      </div>
                      <p className={FORM.secretHint}>
                        Leave blank to use defaults: dev for base branch and
                        main for production branch.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        ) : null}

        {showTargetRepoSection && onAddRepo ? (
          <Button type="button" variant="outline" onClick={onAddRepo}>
            Add additional repo
          </Button>
        ) : null}
      </div>
    );
  }

  const repo = values.repos[0] ?? {
    id: "",
    targetRepo: "",
  };

  return (
    <div className="space-y-6">
      <div className={FORM.fieldGrid}>
        <div className={FORM.fieldStack}>
          <Label htmlFor="linear-team-key">Linear team key</Label>
          <Input
            id="linear-team-key"
            value={values.linearTeamKey ?? ""}
            onChange={(event) =>
              onChange({ ...values, linearTeamKey: event.target.value })
            }
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="model-id">Model ID</Label>
          <Input
            id="model-id"
            value={values.modelId ?? ""}
            onChange={(event) =>
              onChange({ ...values, modelId: event.target.value })
            }
          />
          <p className={FORM.secretHint}>
            Local setup only. Harness runs use standard Composer 2.5 policy.
          </p>
        </div>
      </div>

      <div className={FORM.fieldGrid}>
        <div className={FORM.fieldStack}>
          <Label htmlFor="repo-id">Repo config ID</Label>
          <Input
            id="repo-id"
            value={repo.id}
            onChange={(event) => updateRepo(0, { id: event.target.value })}
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="target-repo">Target repo URL</Label>
          <Input
            id="target-repo"
            value={repo.targetRepo}
            onChange={(event) =>
              updateRepo(0, { targetRepo: event.target.value })
            }
            className={highlightStaleTarget ? "border-destructive/60" : undefined}
          />
          {highlightStaleTarget ? (
            <p className={FORM.secretHint}>
              Enter the target repo you actually intend to use. The app will not
              guess or invent a replacement repo for you.
            </p>
          ) : null}
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="linear-projects">Linear projects</Label>
          <Input
            id="linear-projects"
            value={repo.linearProjects ?? ""}
            onChange={(event) =>
              updateRepo(0, { linearProjects: event.target.value })
            }
            placeholder="Comma-separated"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="linear-teams">Linear teams</Label>
          <Input
            id="linear-teams"
            value={repo.linearTeams ?? ""}
            onChange={(event) =>
              updateRepo(0, { linearTeams: event.target.value })
            }
            placeholder="Comma-separated"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="base-branch">Base branch</Label>
          <Input
            id="base-branch"
            value={repo.baseBranch ?? ""}
            onChange={(event) =>
              updateRepo(0, { baseBranch: event.target.value })
            }
            placeholder="dev"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="production-branch">Production branch</Label>
          <Input
            id="production-branch"
            value={repo.productionBranch ?? ""}
            onChange={(event) =>
              updateRepo(0, { productionBranch: event.target.value })
            }
            placeholder="main"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="preview-provider">Preview provider</Label>
          <Input
            id="preview-provider"
            value={repo.previewProvider ?? ""}
            onChange={(event) =>
              updateRepo(0, { previewProvider: event.target.value })
            }
            placeholder="vercel"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="integration-preview-url">Integration preview URL</Label>
          <Input
            id="integration-preview-url"
            value={repo.integrationPreviewUrl ?? ""}
            onChange={(event) =>
              updateRepo(0, {
                integrationPreviewUrl: event.target.value,
              })
            }
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="production-url">Production URL</Label>
          <Input
            id="production-url"
            value={repo.productionUrl ?? ""}
            onChange={(event) =>
              updateRepo(0, { productionUrl: event.target.value })
            }
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="integration-success-status">
            Integration success status
          </Label>
          <Input
            id="integration-success-status"
            value={repo.integrationSuccessStatus ?? ""}
            onChange={(event) =>
              updateRepo(0, {
                integrationSuccessStatus: event.target.value,
              })
            }
            placeholder="Merged to Dev"
          />
        </div>
        <div className={FORM.fieldStack}>
          <Label htmlFor="production-success-status">
            Production success status
          </Label>
          <Input
            id="production-success-status"
            value={repo.productionSuccessStatus ?? ""}
            onChange={(event) =>
              updateRepo(0, {
                productionSuccessStatus: event.target.value,
              })
            }
            placeholder="Merged / Deployed"
          />
        </div>
      </div>

      <div className={FORM.fieldStack}>
        <Label htmlFor="validation-commands">Validation commands</Label>
        <Textarea
          id="validation-commands"
          value={repo.validationCommands ?? ""}
          onChange={(event) =>
            updateRepo(0, { validationCommands: event.target.value })
          }
          placeholder="One command per line"
          rows={4}
        />
      </div>
    </div>
  );
}

function repoVerificationBadge(state: RepoVerificationUiState) {
  switch (state) {
    case "checking":
      return { label: "Checking", variant: "secondary" as const };
    case "connected":
      return { label: "Connected", variant: "success" as const };
    case "failed":
      return { label: "Failed", variant: "destructive" as const };
    default:
      return { label: "Not connected yet", variant: "secondary" as const };
  }
}

export { GITHUB_REPO_URL_PATTERN };
