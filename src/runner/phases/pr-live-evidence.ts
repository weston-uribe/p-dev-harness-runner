/**
 * Live GitHub PR evidence for Code Review / Code Revision eligibility.
 */

import type { PrInspectionResult } from "../../github/pr-inspector.js";
import type { ParsedPrUrl } from "../../github/pr-url.js";
import { hashDiffIdentity } from "../../workflow/implementation-artifact.js";
import { normalizeRepoUrl } from "../../resolver/normalize-repo.js";

export interface LivePrEvidence {
  prNumber: number;
  repository: string;
  headSha: string;
  baseSha: string;
  diffHash: string;
}

export function buildLivePrEvidence(input: {
  inspection: PrInspectionResult;
  parsed: ParsedPrUrl;
  targetRepo: string;
}): LivePrEvidence {
  const repository = normalizeRepoUrl(input.targetRepo);
  const baseSha = input.inspection.baseSha;
  return {
    prNumber: input.parsed.pullNumber,
    repository,
    headSha: input.inspection.headSha,
    baseSha,
    diffHash: hashDiffIdentity({
      prNumber: input.parsed.pullNumber,
      headSha: input.inspection.headSha,
      baseSha,
    }),
  };
}
