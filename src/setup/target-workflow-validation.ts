import { parseDocument } from "yaml";
import {
  extractDispatchRepoFromCurl,
  hasInvalidHtmlContractMarker,
  isStaleHarnessDispatchRepo,
  parseTargetWorkflowContract,
  TARGET_WORKFLOW_CONTRACT_VERSION,
  TARGET_WORKFLOW_GENERATED_BY,
} from "./target-workflow-contract.js";

export interface TargetWorkflowValidationResult {
  ok: boolean;
  errors: string[];
  parsedKeys: string[];
  productionBranches: string[];
  dispatchRepo: string | null;
  contractVersion: number | null;
}

function collectMapKeys(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/**
 * Parse GitHub Actions workflow YAML with YAML 1.2 so the top-level `on` key
 * retains its string meaning (YAML 1.1 may coerce `on` to boolean).
 */
export function parseTargetWorkflowYamlDocument(content: string): {
  ok: true;
  data: Record<string, unknown>;
  keys: string[];
} | {
  ok: false;
  error: string;
} {
  try {
    const doc = parseDocument(content, {
      version: "1.2",
      prettyErrors: true,
    });
    if (doc.errors.length > 0) {
      return {
        ok: false,
        error: doc.errors.map((error) => error.message).join("; "),
      };
    }
    const data = doc.toJS({ mapAsMap: false }) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "workflow root must be a mapping" };
    }
    const record = data as Record<string, unknown>;
    return { ok: true, data: record, keys: Object.keys(record) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateGeneratedTargetWorkflow(input: {
  content: string;
  expectedProductionBranch: string;
  expectedDispatchRepo: string;
  expectedRepoConfigId: string;
  expectedTargetRepoSlug: string;
}): TargetWorkflowValidationResult {
  const errors: string[] = [];

  if (hasInvalidHtmlContractMarker(input.content)) {
    errors.push("workflow must not use HTML contract markers");
  }
  if (input.content.includes("<!--")) {
    errors.push("workflow comments must use YAML # syntax only");
  }
  if (!input.content.includes(`generated-by: ${TARGET_WORKFLOW_GENERATED_BY}`)) {
    errors.push(`missing generated-by: ${TARGET_WORKFLOW_GENERATED_BY}`);
  }

  const parsed = parseTargetWorkflowYamlDocument(input.content);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [...errors, `yaml_parse_failed: ${parsed.error}`],
      parsedKeys: [],
      productionBranches: [],
      dispatchRepo: null,
      contractVersion: null,
    };
  }

  const keys = parsed.keys;
  for (const required of ["name", "on", "permissions", "jobs"]) {
    if (!keys.includes(required)) {
      errors.push(`missing top-level key: ${required}`);
    }
  }

  if (!keys.includes("on")) {
    errors.push('parsed document must contain literal top-level key "on"');
  }

  const onValue = parsed.data.on;
  const onRecord =
    onValue && typeof onValue === "object" && !Array.isArray(onValue)
      ? (onValue as Record<string, unknown>)
      : null;
  const push =
    onRecord?.push && typeof onRecord.push === "object" && !Array.isArray(onRecord.push)
      ? (onRecord.push as Record<string, unknown>)
      : null;
  const branches = Array.isArray(push?.branches)
    ? push.branches.map((branch) => String(branch))
    : [];

  if (branches.length === 0) {
    errors.push("push.branches must be present");
  }
  if (branches.length > 1 || (branches[0] && branches[0] !== input.expectedProductionBranch)) {
    errors.push(
      `push.branches must be exactly [${input.expectedProductionBranch}]`,
    );
  }

  const dispatchRepo = extractDispatchRepoFromCurl(input.content);
  if (!dispatchRepo) {
    errors.push("missing repository dispatch URL");
  } else if (
    dispatchRepo.toLowerCase() !== input.expectedDispatchRepo.trim().toLowerCase()
  ) {
    errors.push(
      `dispatch repo mismatch: expected ${input.expectedDispatchRepo}, got ${dispatchRepo}`,
    );
  }
  if (isStaleHarnessDispatchRepo(dispatchRepo)) {
    errors.push("dispatch target must not be the archived harness repository");
  }

  if (!input.content.includes('event_type:"production_promoted"')) {
    errors.push("missing production_promoted event type");
  }
  for (const field of [
    `--arg repo ${input.expectedRepoConfigId}`,
    `--arg branch ${input.expectedProductionBranch}`,
    `--arg source ${input.expectedTargetRepoSlug}`,
    '--arg after "${{ github.sha }}"',
    '--arg ref "${{ github.ref }}"',
    '--arg run_id "${{ github.run_id }}"',
    "--arg received",
  ]) {
    if (!input.content.includes(field)) {
      errors.push(`missing payload field wiring: ${field}`);
    }
  }
  if (!input.content.includes("secrets.HARNESS_DISPATCH_TOKEN")) {
    errors.push("missing HARNESS_DISPATCH_TOKEN secret reference");
  }

  const contract = parseTargetWorkflowContract(input.content);
  if (!contract) {
    errors.push("missing parseable contract marker");
  } else if (contract.contractVersion !== TARGET_WORKFLOW_CONTRACT_VERSION) {
    errors.push(
      `contract version must be ${TARGET_WORKFLOW_CONTRACT_VERSION}, got ${contract.contractVersion}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    parsedKeys: keys,
    productionBranches: branches,
    dispatchRepo,
    contractVersion: contract?.contractVersion ?? null,
  };
}

export function assertValidGeneratedTargetWorkflow(
  input: Parameters<typeof validateGeneratedTargetWorkflow>[0],
): void {
  const result = validateGeneratedTargetWorkflow(input);
  if (!result.ok) {
    throw new Error(
      `invalid generated target workflow: ${result.errors.join("; ")}`,
    );
  }
}

export function summarizeParsedWorkflowKeys(content: string): string[] {
  const parsed = parseTargetWorkflowYamlDocument(content);
  return parsed.ok ? parsed.keys : collectMapKeys(null);
}
