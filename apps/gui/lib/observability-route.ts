import { NextResponse } from "next/server";
import {
  captureProductError,
  flushObservability,
} from "@harness/observability/facade.js";
import type { ErrorCategory, LifecyclePhase } from "@harness/observability/types.js";

export interface ObservabilityRouteFailureInput {
  lifecyclePhase: LifecyclePhase;
  productErrorCode: string;
  errorCategory?: ErrorCategory;
  cause?: unknown;
  message?: string;
  publicMessage?: string;
  status?: number;
  configureStepId?: string;
  capture?: boolean;
}

export function isExpectedSetupValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("missing") ||
    message.includes("required") ||
    message.includes("invalid json") ||
    message.includes("not ready") ||
    message.includes("confirmation")
  );
}

export async function handleObservabilityRouteFailure(
  error: unknown,
  input: ObservabilityRouteFailureInput,
): Promise<NextResponse> {
  const message =
    error instanceof Error ? error.message : "Unexpected Configure API failure";

  const shouldCapture =
    input.capture ??
    !isExpectedSetupValidationError(error);

  if (shouldCapture) {
    captureProductError({
      lifecyclePhase: input.lifecyclePhase,
      productErrorCode: input.productErrorCode,
      errorCategory: input.errorCategory ?? "unexpected",
      cause: error,
      configureStepId: input.configureStepId,
    });
    await flushObservability();
  }

  return NextResponse.json(
    { error: input.publicMessage ?? message },
    { status: input.status ?? 400 },
  );
}

export async function withObservabilityRoute<T>(
  lifecyclePhase: LifecyclePhase,
  productErrorCode: string,
  handler: () => Promise<T>,
): Promise<T | NextResponse> {
  try {
    return await handler();
  } catch (error) {
    return await handleObservabilityRouteFailure(error, {
      lifecyclePhase,
      productErrorCode,
    });
  }
}
