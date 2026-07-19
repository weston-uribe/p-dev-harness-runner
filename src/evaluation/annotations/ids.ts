import { createHash, randomBytes } from "node:crypto";

const ANNOTATION_PREFIX = "p-dev:annotation:v1";
const IDEMPOTENCY_PREFIX = "p-dev:annotation-idempotency:v1";

function sha256Hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function generateAnnotationNonce(): string {
  return randomBytes(16).toString("hex");
}

export function deriveAnnotationId(params: {
  evaluationSubjectId: string;
  rubricId: string;
  rubricVersion: string;
  dimensionId: string;
  createdAt: string;
  nonce: string;
}): string {
  return sha256Hex(
    `${ANNOTATION_PREFIX}:${params.evaluationSubjectId}:${params.rubricId}:${params.rubricVersion}:${params.dimensionId}:${params.createdAt}:${params.nonce}`,
  );
}

export function deriveAnnotationIdempotencyKey(params: {
  evaluationSubjectId: string;
  rubricId: string;
  rubricVersion: string;
  dimensionId: string;
  clientRequestId: string;
}): string {
  return sha256Hex(
    `${IDEMPOTENCY_PREFIX}:${params.evaluationSubjectId}:${params.rubricId}:${params.rubricVersion}:${params.dimensionId}:${params.clientRequestId}`,
  );
}
