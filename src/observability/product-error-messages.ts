const APPROVED_PRODUCT_ERROR_MESSAGES: Record<string, string> = {
  uncaught_exception: "An unexpected uncaught exception occurred.",
  unhandled_rejection: "An unexpected unhandled rejection occurred.",
  configure_gui_spawn_error: "The Configure GUI process failed to start.",
  configure_gui_health_check_failed:
    "The Configure GUI failed its startup health check.",
  configure_request_error: "A Configure request failed unexpectedly.",
  provision_failed: "Harness workspace provisioning failed.",
  p_dev_launch_failed: "The p-dev launcher failed during startup.",
  harness_repo_provisioning_route_failed:
    "Harness workspace provisioning failed.",
  remote_prompt_fetch_failure: "Remote prompt fetch failed.",
  prompt_schema_mismatch: "Remote prompt schema did not match the local contract.",
  prompt_compile_failure: "Prompt compilation failed.",
  skill_packaging_invalid: "A canonical skill package failed validation.",
  native_skill_capability_contradiction:
    "Native skill capability state contradicted runtime policy.",
  native_skill_invocation_failure: "Native skill invocation failed.",
};

export function approvedProductErrorMessage(productErrorCode: string): string {
  return (
    APPROVED_PRODUCT_ERROR_MESSAGES[productErrorCode] ??
    `Product error: ${productErrorCode}`
  );
}
