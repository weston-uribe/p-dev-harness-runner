import "server-only";
import { cache } from "react";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  buildWorkspaceHealthSnapshot,
  type WorkspaceHealthSnapshot,
} from "@harness/setup/workspace-health-snapshot";

export type { WorkspaceHealthSnapshot };

/** Per-request deduped durable-first health snapshot (no live credential verify). */
export const loadWorkspaceHealthSnapshot = cache(
  async (): Promise<WorkspaceHealthSnapshot> =>
    buildWorkspaceHealthSnapshot({
      cwd: resolveHarnessWorkspaceDir(),
      liveCredentials: false,
    }),
);
