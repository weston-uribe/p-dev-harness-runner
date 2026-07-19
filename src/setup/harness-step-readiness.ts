export type HarnessRepoVerificationState =
  | "unchecked"
  | "checking"
  | "connected"
  | "failed";

export function isHarnessRepoInheritedFromStep1(
  effectiveRepo: string,
  step1TrustedRepo: string | null | undefined,
): boolean {
  const effective = effectiveRepo.trim();
  const trusted = step1TrustedRepo?.trim();
  return Boolean(effective && trusted && effective === trusted);
}

export function isHarnessRepoManuallyVerified(options: {
  effectiveRepo: string;
  verificationState: HarnessRepoVerificationState;
  verifiedRepo?: string;
  activeGithubTokenFingerprint?: string | null;
  verifiedGithubTokenFingerprint?: string;
}): boolean {
  const effective = options.effectiveRepo.trim();
  if (!effective || options.verificationState !== "connected") {
    return false;
  }
  if (options.verifiedRepo !== effective) {
    return false;
  }
  if (
    options.activeGithubTokenFingerprint &&
    options.verifiedGithubTokenFingerprint !==
      options.activeGithubTokenFingerprint
  ) {
    return false;
  }
  return true;
}

export function isHarnessRepoReadyForGuidedStep4(options: {
  effectiveRepo: string;
  step1TrustedRepo: string | null | undefined;
  serverValidatedRepo: string | null | undefined;
  manualVerification: {
    state: HarnessRepoVerificationState;
    verifiedRepo?: string;
    verifiedGithubTokenFingerprint?: string;
  };
  activeGithubTokenFingerprint?: string | null;
}): boolean {
  const effective = options.effectiveRepo.trim();
  if (!effective) {
    return false;
  }

  if (isHarnessRepoInheritedFromStep1(effective, options.step1TrustedRepo)) {
    return true;
  }

  if (options.serverValidatedRepo?.trim() === effective) {
    return true;
  }

  return isHarnessRepoManuallyVerified({
    effectiveRepo: effective,
    verificationState: options.manualVerification.state,
    verifiedRepo: options.manualVerification.verifiedRepo,
    activeGithubTokenFingerprint: options.activeGithubTokenFingerprint,
    verifiedGithubTokenFingerprint:
      options.manualVerification.verifiedGithubTokenFingerprint,
  });
}
