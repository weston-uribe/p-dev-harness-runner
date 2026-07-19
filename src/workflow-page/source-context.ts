import {
  isWorkflowFixtureId,
  P_DEV_OPERATIONS_FIXTURES_ENV,
  P_DEV_WORKFLOW_FIXTURES_ENV,
} from "./constants.js";
import type { WorkflowSourceContext, WorkflowSourceMode } from "./types.js";

export interface SourceContextRequest {
  source?: string | null;
  fixture?: string | null;
  scope?: string | null;
  fixturesEnabled?: boolean;
}

export function isFixturesOptInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env[P_DEV_WORKFLOW_FIXTURES_ENV] === "1" ||
    env[P_DEV_OPERATIONS_FIXTURES_ENV] === "1"
  );
}

export function resolveWorkflowSourceContext(
  request: SourceContextRequest,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowSourceContext {
  const fixturesEnabled = request.fixturesEnabled ?? isFixturesOptInEnabled(env);
  const source = request.source?.trim().toLowerCase();
  const fixture = request.fixture?.trim();
  const scope = request.scope?.trim();

  if (source === "fixture" || fixture) {
    if (!fixturesEnabled) {
      return {
        mode: "fixture",
        fixtureId: fixture,
        fixturesEnabled: false,
        rejectionReason:
          "Fixture mode requires explicit server opt-in via P_DEV_WORKFLOW_FIXTURES=1 or P_DEV_OPERATIONS_FIXTURES=1.",
      };
    }

    if (!fixture || !isWorkflowFixtureId(fixture)) {
      return {
        mode: "fixture",
        fixtureId: fixture,
        fixturesEnabled: true,
        rejectionReason: fixture
          ? `Unknown fixture id: ${fixture}`
          : "Fixture id is required when source=fixture.",
      };
    }

    return {
      mode: "fixture",
      fixtureId: fixture,
      scopeId: scope,
      fixturesEnabled: true,
    };
  }

  return {
    mode: "live",
    scopeId: scope,
    fixturesEnabled,
  };
}

export function dataSourceLabel(context: WorkflowSourceContext): string {
  if (context.rejectionReason) {
    return "Unavailable";
  }
  if (context.mode === "fixture") {
    return "Browser test fixture";
  }
  return "Live harness configuration";
}

export function assertWritableSourceContext(
  context: WorkflowSourceContext,
): WorkflowSourceContext {
  if (context.rejectionReason) {
    throw new Error(context.rejectionReason);
  }
  return context;
}

export function sourceModeFromContext(
  context: WorkflowSourceContext,
): WorkflowSourceMode {
  return context.mode;
}
