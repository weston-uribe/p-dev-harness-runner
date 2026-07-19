#!/usr/bin/env node
import { launchPDev } from "./launch.js";
import {
  captureProductError,
  shutdownObservability,
} from "../observability/facade.js";

await launchPDev({
  moduleUrl: import.meta.url,
}).catch(async (error: unknown) => {
  captureProductError({
    lifecyclePhase: "launcher_startup",
    productErrorCode: "p_dev_launch_failed",
    errorCategory: "unexpected",
    cause: error,
  });
  await shutdownObservability();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`p-dev failed: ${message}`);
  process.exit(1);
});
