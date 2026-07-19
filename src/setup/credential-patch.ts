import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  verifySetupService,
  type SetupServiceName,
} from "./service-verification.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { CredentialHealthStatus } from "./workspace-health.js";
import { classifyVerificationFailure } from "./credential-health.js";

export type PatchableCredentialKey =
  | "LINEAR_API_KEY"
  | "CURSOR_API_KEY"
  | "GITHUB_TOKEN"
  | "VERCEL_TOKEN";

const KEY_TO_SERVICE: Record<PatchableCredentialKey, SetupServiceName> = {
  LINEAR_API_KEY: "linear",
  CURSOR_API_KEY: "cursor",
  GITHUB_TOKEN: "github",
  VERCEL_TOKEN: "vercel",
};

const PRESERVED_KEYS = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
  "HARNESS_CONFIG_PATH",
  "GITHUB_DISPATCH_REPOSITORY",
] as const;

export type CredentialPatchInput = {
  key: PatchableCredentialKey;
  value: string;
  expectedConfigFingerprint: string;
};

export type CredentialPatchPreview = {
  key: PatchableCredentialKey;
  expectedConfigFingerprint: string;
  /** SHA-256 of current .env.local bytes (or "missing"). Never includes secret values. */
  envContentFingerprint: string;
  keyPresent: boolean;
};

export type CredentialPatchResult =
  | {
      ok: true;
      key: PatchableCredentialKey;
      envContentFingerprint: string;
      verification: {
        status: "connected";
        message: string;
        label?: string;
      };
    }
  | {
      ok: false;
      conflict?: boolean;
      unauthorized?: boolean;
      key: PatchableCredentialKey;
      message: string;
      credentialHealth: CredentialHealthStatus;
      /** Previous token preserved when verification fails. */
      previousTokenPreserved: boolean;
    };

export function computeEnvContentFingerprint(content: string | null): string {
  if (content === null) {
    return "missing";
  }
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function extractEnvValue(content: string, key: string): string | undefined {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (trimmed.slice(0, separator).trim() === key) {
      return trimmed.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * Replace a single KEY=value line. All other lines are preserved byte-for-byte
 * (including unrelated managed keys and comments).
 */
export function patchEnvFileContentSingleKey(
  existingContent: string | null,
  key: PatchableCredentialKey,
  value: string,
): string {
  const trimmedValue = value.trim();
  const replacementLine = `${key}=${trimmedValue}`;

  if (existingContent === null || existingContent.length === 0) {
    return `${replacementLine}\n`;
  }

  const lines = existingContent.split("\n");
  let replaced = false;
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      return line;
    }
    if (trimmed.slice(0, separator).trim() !== key) {
      return line;
    }
    replaced = true;
    return replacementLine;
  });

  if (!replaced) {
    if (output.length > 0 && output[output.length - 1] !== "") {
      output.push("");
    }
    output.push(replacementLine);
  }

  let result = output.join("\n");
  if (existingContent.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

/** Assert unrelated keys are unchanged between two env file contents. */
export function assertUnrelatedEnvKeysPreserved(
  before: string,
  after: string,
  patchedKey: PatchableCredentialKey,
): void {
  for (const key of PRESERVED_KEYS) {
    if (key === patchedKey) {
      continue;
    }
    const beforeValue = extractEnvValue(before, key);
    const afterValue = extractEnvValue(after, key);
    if (beforeValue !== afterValue) {
      throw new Error(
        `Credential patch mutated unrelated key ${key} (byte-for-byte preserve failed).`,
      );
    }
  }
}

export async function readEnvLocalContentFingerprint(
  cwd?: string,
): Promise<{ content: string | null; fingerprint: string; keyPresent: Record<PatchableCredentialKey, boolean> }> {
  const paths = resolveLocalFilePaths(cwd);
  let content: string | null = null;
  try {
    await access(paths.envLocal);
    content = await readFile(paths.envLocal, "utf8");
  } catch {
    content = null;
  }
  const fingerprint = computeEnvContentFingerprint(content);
  return {
    content,
    fingerprint,
    keyPresent: {
      LINEAR_API_KEY: Boolean(content && extractEnvValue(content, "LINEAR_API_KEY")),
      CURSOR_API_KEY: Boolean(content && extractEnvValue(content, "CURSOR_API_KEY")),
      GITHUB_TOKEN: Boolean(content && extractEnvValue(content, "GITHUB_TOKEN")),
      VERCEL_TOKEN: Boolean(content && extractEnvValue(content, "VERCEL_TOKEN")),
    },
  };
}

export async function previewCredentialPatch(options: {
  cwd?: string;
  key: PatchableCredentialKey;
}): Promise<CredentialPatchPreview> {
  const { content, fingerprint, keyPresent } = await readEnvLocalContentFingerprint(
    options.cwd,
  );
  return {
    key: options.key,
    expectedConfigFingerprint: fingerprint,
    envContentFingerprint: fingerprint,
    keyPresent: keyPresent[options.key],
    // content intentionally unused — never returned
    ...(content ? {} : {}),
  };
}

export async function applyCredentialPatch(options: {
  cwd?: string;
  patch: CredentialPatchInput;
}): Promise<CredentialPatchResult> {
  const key = options.patch.key;
  const value = options.patch.value.trim();
  if (!value) {
    return {
      ok: false,
      key,
      message: `Enter a value for ${key} before saving.`,
      credentialHealth: "missing",
      previousTokenPreserved: true,
    };
  }

  const { content, fingerprint } = await readEnvLocalContentFingerprint(options.cwd);
  if (fingerprint !== options.patch.expectedConfigFingerprint) {
    return {
      ok: false,
      conflict: true,
      key,
      message:
        "Environment file changed since this edit started. Refresh and try again.",
      credentialHealth: "unknown",
      previousTokenPreserved: true,
    };
  }

  const verification = await verifySetupService({
    cwd: options.cwd,
    service: KEY_TO_SERVICE[key],
    token: value,
  });

  if (verification.status !== "connected") {
    const health = classifyVerificationFailure(verification);
    return {
      ok: false,
      unauthorized:
        health === "unauthorized" || health === "credential_invalid",
      key,
      message: verification.message,
      credentialHealth: health,
      previousTokenPreserved: true,
    };
  }

  const nextContent = patchEnvFileContentSingleKey(content, key, value);
  if (content !== null) {
    assertUnrelatedEnvKeysPreserved(content, nextContent, key);
  }

  const paths = resolveLocalFilePaths(options.cwd);
  await mkdir(path.dirname(paths.envLocal), { recursive: true });
  const tempPath = `${paths.envLocal}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, nextContent, "utf8");
  await rename(tempPath, paths.envLocal);

  const afterFingerprint = computeEnvContentFingerprint(nextContent);
  return {
    ok: true,
    key,
    envContentFingerprint: afterFingerprint,
    verification: {
      status: "connected",
      message: verification.message,
      label: verification.label,
    },
  };
}
