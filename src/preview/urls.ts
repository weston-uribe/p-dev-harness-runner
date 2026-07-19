export interface ResolvedPreviewLinks {
  issuePreviewUrl: string | null;
  integrationPreviewUrl: string | null;
  productionUrl: string | null;
  mergedToProduction: boolean;
  notYetInProduction: boolean;
}

export function resolvePreviewLinks(input: {
  prPreviewUrl?: string | null;
  integrationPreviewUrl?: string | null;
  productionUrl?: string | null;
  capturedDeploymentUrl?: string | null;
  mergedBaseBranch: string;
  productionBranch: string;
}): ResolvedPreviewLinks {
  const mergedToProduction = input.mergedBaseBranch === input.productionBranch;

  return {
    issuePreviewUrl: input.prPreviewUrl ?? null,
    integrationPreviewUrl: input.integrationPreviewUrl ?? null,
    productionUrl: mergedToProduction
      ? input.capturedDeploymentUrl ?? input.productionUrl ?? null
      : null,
    mergedToProduction,
    notYetInProduction: !mergedToProduction,
  };
}
