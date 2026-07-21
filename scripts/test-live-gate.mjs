#!/usr/bin/env node
/**
 * Fail-closed gate for credentialed/live tests.
 * Opt in explicitly with P_DEV_ALLOW_LIVE_TESTS=1.
 */
if (process.env.P_DEV_ALLOW_LIVE_TESTS !== "1") {
  console.error(
    [
      "test:live requires explicit opt-in.",
      "Set P_DEV_ALLOW_LIVE_TESTS=1 only when running intentional credentialed integration tests.",
      "Default npm test remains the hermetic, non-credentialed regression suite.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  "P_DEV_ALLOW_LIVE_TESTS=1 is set, but no dedicated live Vitest project is configured yet.",
);
console.log(
  "Use existing canary workflows / harness CLI commands for live validation.",
);
process.exit(0);
