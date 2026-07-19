export function emptyMergeManifestFields() {
  return {
    previousRevisionRunId: null as string | null,
    mergeCommitSha: null as string | null,
    mergeMethod: null as string | null,
    mergedAt: null as string | null,
    deploymentUrl: null as string | null,
  };
}
