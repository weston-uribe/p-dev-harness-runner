import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const REMOTE_GUI_COMPONENTS = [
  "apps/gui/components/custom/remote-setup-section.tsx",
  "apps/gui/components/custom/remote-secret-form.tsx",
  "apps/gui/components/custom/remote-action-preview.tsx",
  "apps/gui/components/custom/remote-action-confirmation.tsx",
  "apps/gui/components/custom/target-workflow-pr-card.tsx",
  "apps/gui/components/custom/guided-cloud-secrets-card.tsx",
  "apps/gui/components/custom/guided-target-workflow-card.tsx",
  "apps/gui/components/custom/review-cloud-secrets-disclosure.tsx",
  "apps/gui/components/custom/configure-experience.tsx",
  "apps/gui/components/custom/first-run-stepper.tsx",
  "apps/gui/components/custom/readiness-banner.tsx",
];

const FORBIDDEN_STORAGE_PATTERNS = [
  /localStorage/,
  /sessionStorage/,
  /indexedDB/i,
  /document\.cookie/,
];

describe("remote setup GUI storage boundary", () => {
  for (const relativePath of REMOTE_GUI_COMPONENTS) {
    it(`${relativePath} does not persist secrets in browser storage`, () => {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const pattern of FORBIDDEN_STORAGE_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
